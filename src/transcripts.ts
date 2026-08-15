import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { projectsDir } from './paths.js';
import { attribute } from './project.js';
import { mergeSpans, totalMs } from './spans.js';
import type { ParseResult, SessionRecord, Span } from './types.js';

/** The record Claude Code writes at the end of every completed agent turn. */
const TURN_MARKER = '"turn_duration"';
/** Only records for prompts a human actually typed carry this. */
const PROMPT_MARKER = '"promptSource"';

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

export interface TranscriptFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/**
 * Every main-thread transcript.
 *
 * Subagent transcripts live one level deeper, in
 * `<slug>/<sessionId>/subagents/agent-*.jsonl`, so taking only files directly
 * inside a project slug excludes them. That is both a large speedup (480 files and
 * 244 MB skipped on the author's machine) and the correct semantics: a subagent is
 * part of its parent session, never a session of its own.
 */
export async function listTranscripts(): Promise<TranscriptFile[]> {
  const root = projectsDir();
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return [];
  }

  const files: TranscriptFile[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      try {
        const st = await stat(file);
        files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // deleted between readdir and stat
      }
    }
  }
  return files;
}

/**
 * Read one transcript and reconstruct its session.
 *
 * The performance of the whole tool is this function's prefilter: a substring check
 * before JSON.parse. Attachment records are roughly a third of all lines and most of
 * the bytes, and nothing in them matters here, so 99% of lines never get parsed.
 */
export async function parseTranscript(tf: TranscriptFile): Promise<ParseResult> {
  const stream = createReadStream(tf.file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let prompts = 0;
  let turns = 0;
  let lines = 0;
  let parsed = 0;
  const raw: Span[] = [];

  try {
    for await (const line of rl) {
      lines++;
      if (line.length < 2) continue;

      const isTurn = line.includes(TURN_MARKER);

      // Cheap scalar extraction for the overwhelming majority of lines.
      if (!isTurn) {
        if (line.includes(PROMPT_MARKER)) prompts++;

        const ts = TIMESTAMP_RE.exec(line);
        if (ts?.[1]) {
          const t = Date.parse(ts[1]);
          if (Number.isFinite(t)) {
            if (first === undefined || t < first) first = t;
            if (last === undefined || t > last) last = t;
          }
        }

        // Session identity appears on nearly every record; grab it once.
        if (!sessionId || !cwd || !version) {
          if (line.includes('"cwd"') || line.includes('"sessionId"')) {
            try {
              const d = JSON.parse(line) as Record<string, unknown>;
              parsed++;
              if (!sessionId && typeof d['sessionId'] === 'string') sessionId = d['sessionId'];
              if (!cwd && typeof d['cwd'] === 'string') cwd = d['cwd'];
              if (!version && typeof d['version'] === 'string') version = d['version'];
            } catch {
              // truncated final line during an active write
            }
          }
        }
        continue;
      }

      // A turn_duration record: the one thing worth a full parse.
      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        parsed++;
        if (!sessionId && typeof d['sessionId'] === 'string') sessionId = d['sessionId'];
        if (!cwd && typeof d['cwd'] === 'string') cwd = d['cwd'];
        if (!version && typeof d['version'] === 'string') version = d['version'];

        if (d['subtype'] !== 'turn_duration') continue;
        const duration = d['durationMs'];
        const stamp = d['timestamp'];
        if (typeof duration !== 'number' || duration <= 0) continue;
        if (typeof stamp !== 'string') continue;

        const end = Date.parse(stamp);
        if (!Number.isFinite(end)) continue;

        if (first === undefined || end < first) first = end;
        if (last === undefined || end > last) last = end;

        turns++;
        raw.push({ start: end - duration, end });
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    return { record: null, lines, parsed };
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!sessionId || first === undefined || last === undefined) {
    return { record: null, lines, parsed };
  }

  // Fall back to the directory slug only if no record carried a cwd. The slug maps
  // both "/" and "." to "-", so it is lossy and cannot be reversed reliably.
  const workingDir = cwd ?? path.basename(path.dirname(tf.file));
  const { project, label } = attribute(workingDir);

  const spans = mergeSpans(raw);
  const startedAt = Math.min(first, spans[0]?.start ?? first);
  const endedAt = Math.max(last, spans[spans.length - 1]?.end ?? last);

  const record: SessionRecord = {
    sessionId,
    cwd: workingDir,
    project,
    label,
    startedAt,
    endedAt,
    turns,
    activeMs: totalMs(spans),
    hasTurnData: turns > 0,
    prompts,
    spans,
    file: tf.file,
    mtimeMs: tf.mtimeMs,
    size: tf.size,
  };
  if (version) record.version = version;

  return { record, lines, parsed };
}

export interface ScanOptions {
  /** Files already parsed and unchanged since — skipped entirely. */
  skip?: (tf: TranscriptFile) => boolean;
  onProgress?: (done: number, total: number) => void;
  /** Files parsed at once. Bounded so a huge ~/.claude can't exhaust file handles. */
  concurrency?: number;
}

export interface ScanResult {
  records: SessionRecord[];
  scanned: number;
  skipped: number;
  lines: number;
  parsedLines: number;
}

/** Parse every transcript that isn't already known, with bounded parallelism. */
export async function scanTranscripts(options: ScanOptions = {}): Promise<ScanResult> {
  const all = await listTranscripts();
  const todo = options.skip ? all.filter((tf) => !options.skip!(tf)) : all;

  const limit = Math.max(1, options.concurrency ?? 8);
  const records: SessionRecord[] = [];
  let lines = 0;
  let parsedLines = 0;
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= todo.length) return;
      const tf = todo[index]!;
      try {
        const result = await parseTranscript(tf);
        lines += result.lines;
        parsedLines += result.parsed;
        if (result.record) records.push(result.record);
      } catch {
        // unreadable transcript — skip rather than abort the run
      }
      done++;
      options.onProgress?.(done, todo.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, worker));

  return {
    records,
    scanned: todo.length,
    skipped: all.length - todo.length,
    lines,
    parsedLines,
  };
}
