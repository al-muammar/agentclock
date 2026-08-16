import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { claudeProjectsDir, claudeRoot, claudeSessionsDir } from '../paths.js';
import { attribute } from '../project.js';
import { pidAlive, rejectRecycledPids } from '../proc.js';
import { mergeSpans, totalMs } from '../spans.js';
import type { LiveSession, ParseResult, SessionFile, SessionRecord, Span } from '../types.js';
import type { AgentAdapter, AgentListing } from './types.js';

export const CLAUDE_ID = 'claude';

/** The record Claude Code writes at the end of every completed agent turn. */
const TURN_MARKER = '"turn_duration"';
/** Only records for prompts a human actually typed carry this. */
const PROMPT_MARKER = '"promptSource"';

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

/** Session kinds that are infrastructure rather than someone's coding session. */
const EXCLUDED_KINDS: ReadonlySet<string> = new Set(['daemon', 'daemon-worker']);

/**
 * Every main-thread transcript.
 *
 * Subagent transcripts live one level deeper, in
 * `<slug>/<sessionId>/subagents/agent-*.jsonl`, so taking only files directly
 * inside a project slug excludes them. That is both a large speedup (480 files and
 * 244 MB skipped on the author's machine) and the correct semantics: a subagent is
 * part of its parent session, never a session of its own.
 */
export async function listTranscripts(): Promise<AgentListing> {
  const root = claudeProjectsDir();
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return { files: [] };
  }

  const files: SessionFile[] = [];
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
  return { files };
}

/**
 * Read one transcript and reconstruct its session.
 *
 * The performance of the whole tool is this function's prefilter: a substring check
 * before JSON.parse. Attachment records are roughly a third of all lines and most of
 * the bytes, and nothing in them matters here, so 99% of lines never get parsed.
 */
export async function parseTranscript(tf: SessionFile): Promise<ParseResult> {
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
    agent: CLAUDE_ID,
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

function toSession(raw: unknown): LiveSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['pid'] !== 'number') return null;
  if (typeof r['sessionId'] !== 'string') return null;
  if (typeof r['cwd'] !== 'string') return null;

  const session: LiveSession = {
    agent: CLAUDE_ID,
    pid: r['pid'],
    sessionId: r['sessionId'],
    cwd: r['cwd'],
    startedAt: typeof r['startedAt'] === 'number' ? r['startedAt'] : Date.now(),
    // Carried verbatim. An unrecognised status must surface, not be coerced.
    status: typeof r['status'] === 'string' ? r['status'] : 'unknown',
    kind: typeof r['kind'] === 'string' ? r['kind'] : 'interactive',
  };

  if (typeof r['name'] === 'string') session.name = r['name'];
  if (typeof r['waitingFor'] === 'string') session.waitingFor = r['waitingFor'];
  if (typeof r['version'] === 'string') session.version = r['version'];
  if (typeof r['entrypoint'] === 'string') session.entrypoint = r['entrypoint'];
  if (typeof r['procStart'] === 'string') session.procStart = r['procStart'];
  if (typeof r['updatedAt'] === 'number') session.updatedAt = r['updatedAt'];
  if (typeof r['statusUpdatedAt'] === 'number') session.statusUpdatedAt = r['statusUpdatedAt'];

  return session;
}

/**
 * Every Claude Code session running right now.
 *
 * Note there is exactly one entry per session, not per agent: subagents run inside
 * their parent and share its sessionId, so a session with five subagents working
 * appears here once. That is the "N subagents count as 1" rule, and it needs no code.
 */
export async function readLiveSessions(): Promise<LiveSession[]> {
  const dir = claudeSessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.endsWith('.json'));
  const parsed: LiveSession[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(dir, file), 'utf8');
    } catch {
      continue; // session exited mid-read
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue; // torn write
    }
    const session = toSession(raw);
    if (!session) continue;
    if (EXCLUDED_KINDS.has(session.kind)) continue; // infrastructure, not a coding session
    if (!pidAlive(session.pid)) continue;
    parsed.push(session);
  }

  return rejectRecycledPids(parsed);
}

export const claudeAdapter: AgentAdapter = {
  id: CLAUDE_ID,
  name: 'Claude Code',
  root: claudeRoot,
  async detect(): Promise<boolean> {
    try {
      await stat(claudeProjectsDir());
      return true;
    } catch {
      return false;
    }
  },
  list: listTranscripts,
  parse: parseTranscript,
  live: readLiveSessions,
};
