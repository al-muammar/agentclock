import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { codexRoot, codexSessionsDir } from '../paths.js';
import { attribute } from '../project.js';
import { mergeSpans, totalMs } from '../spans.js';
import type { ParseResult, SessionFile, SessionRecord, Span } from '../types.js';
import type { AgentAdapter, AgentListing } from './types.js';

export const CODEX_ID = 'codex';

/**
 * Codex writes one JSONL "rollout" per session:
 *
 *   {"timestamp":"…","type":"event_msg","payload":{"type":"task_complete",…}}
 *
 * `type` names the record variant (session_meta · response_item · event_msg ·
 * turn_context · compacted) and `payload` carries it. Only event_msg and the
 * leading session_meta matter here, so the same substring prefilter that keeps the
 * Claude parser fast applies: response_item lines hold whole tool outputs and are
 * most of the bytes, and none of them is ever parsed.
 */
const EVENT_MARKER = '"type":"event_msg"';
const META_MARKER = '"type":"session_meta"';

/**
 * Turn boundaries. Codex renamed these and still emits either wire name.
 *
 * The `"type":` prefix matters: a prompt or a tool result can quote any of these
 * words, and matching a bare `"task_complete"` would let a conversation about Codex
 * fabricate turns inside its own rollout.
 */
const COMPLETE_MARKERS = ['"type":"task_complete"', '"type":"turn_complete"'];
const STARTED_MARKERS = ['"type":"task_started"', '"type":"turn_started"'];
/** The event Codex logs for a prompt a human typed. */
const PROMPT_MARKER = '"type":"user_message"';

/** Payload `type` values that mean "a turn finished". */
const COMPLETE_TYPES: ReadonlySet<string> = new Set(['task_complete', 'turn_complete']);

/**
 * The top-level line timestamp. RolloutLine serialises `timestamp` first, so the
 * first match is the line's own stamp and not one nested inside a payload.
 */
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

/** `rollout-2025-10-07T12-00-00-<uuid>.jsonl` — the id of last resort. */
const FILENAME_ID_RE =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/** How deep to walk under `sessions/`. The layout is YYYY/MM/DD, so 3 is enough. */
const MAX_DEPTH = 4;

function has(line: string, markers: readonly string[]): boolean {
  for (const marker of markers) {
    if (line.includes(marker)) return true;
  }
  return false;
}

/** Codex stamps are ISO strings, but epoch numbers turn up in older builds. */
function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The payload of a rollout line.
 *
 * `payload` is the serde content key; `item` shows up in some builds and in the
 * community documentation. Accepting either costs one `??` and saves the whole
 * adapter from breaking on a rename.
 */
function payloadOf(line: Record<string, unknown>): Record<string, unknown> {
  const p = line['payload'] ?? line['item'];
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/**
 * Every rollout under `~/.codex/sessions`.
 *
 * Cold rollouts are re-written as `.jsonl.zst`. Node 18.17 — the floor this tool
 * supports — has no zstd, so they are counted and surfaced rather than dropped on
 * the floor: a report missing half the history should say so.
 */
export async function listRollouts(): Promise<AgentListing> {
  const files: SessionFile[] = [];
  let compressed = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.jsonl.zst') || entry.name.endsWith('.zst')) {
        compressed++;
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        const st = await stat(full);
        files.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // deleted between readdir and stat
      }
    }
  }

  await walk(codexSessionsDir(), 0);

  if (compressed === 0) return { files };
  return {
    files,
    unreadable: {
      count: compressed,
      reason: 'zstd-compressed rollouts (.jsonl.zst); Node 18 cannot decompress them',
    },
  };
}

/**
 * Read one rollout and reconstruct its session.
 *
 * Working time comes from the turn-completion event, in descending order of
 * precision:
 *
 *   1. `started_at` + `completed_at` — the turn's own measured bounds.
 *   2. `duration_ms` measured back from `completed_at`.
 *   3. The `task_started` line's stamp paired with the `task_complete` line's.
 *
 * All three are Codex timing Codex itself recorded; none is inferred from gaps
 * between messages. A rollout old enough to carry none of them reports no working
 * time and `hasTurnData: false`, exactly as a pre-2.1.222 Claude transcript does.
 */
export async function parseRollout(tf: SessionFile): Promise<ParseResult> {
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
  /** Stamp of the most recent unmatched task_started, for the fallback pairing. */
  let pendingStart: number | undefined;
  const raw: Span[] = [];

  const note = (t: number | undefined): void => {
    if (t === undefined) return;
    if (first === undefined || t < first) first = t;
    if (last === undefined || t > last) last = t;
  };

  try {
    for await (const line of rl) {
      lines++;
      if (line.length < 2) continue;

      const stampMatch = TIMESTAMP_RE.exec(line);
      const stamp = stampMatch?.[1] ? parseTime(stampMatch[1]) : undefined;
      note(stamp);

      // The first line of every rollout, and the only place cwd is recorded.
      if ((!sessionId || !cwd || !version) && line.includes(META_MARKER)) {
        try {
          const d = JSON.parse(line) as Record<string, unknown>;
          parsed++;
          const p = payloadOf(d);
          // Some builds nest the session fields one level further, under `meta`.
          const meta =
            p['meta'] && typeof p['meta'] === 'object' ? (p['meta'] as Record<string, unknown>) : p;
          const id = meta['id'] ?? meta['session_id'] ?? meta['conversation_id'];
          if (!sessionId && typeof id === 'string') sessionId = id;
          if (!cwd && typeof meta['cwd'] === 'string') cwd = meta['cwd'];
          if (!version && typeof meta['cli_version'] === 'string') version = meta['cli_version'];
          note(parseTime(meta['timestamp']));
        } catch {
          // torn write; the filename still yields an id
        }
        continue;
      }

      if (!line.includes(EVENT_MARKER)) continue;

      if (has(line, STARTED_MARKERS)) {
        // Overwrite rather than queue: turns are sequential, so a start with no
        // completion (a crash, a hard ^C) must not be paired with a later turn.
        pendingStart = stamp;
        continue;
      }

      if (line.includes(PROMPT_MARKER)) {
        prompts++;
        continue;
      }

      if (!has(line, COMPLETE_MARKERS)) continue;

      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        parsed++;
        const p = payloadOf(d);
        // The substring got us here; the parsed field decides. A turn-completion
        // marker quoted inside some other event must not become a turn.
        if (typeof p['type'] === 'string' && !COMPLETE_TYPES.has(p['type'])) continue;

        const startedAt = parseTime(p['started_at']);
        const completedAt = parseTime(p['completed_at']) ?? stamp;
        const durationMs = typeof p['duration_ms'] === 'number' ? p['duration_ms'] : undefined;

        let span: Span | undefined;
        if (startedAt !== undefined && completedAt !== undefined && completedAt > startedAt) {
          span = { start: startedAt, end: completedAt };
        } else if (durationMs !== undefined && durationMs > 0 && completedAt !== undefined) {
          span = { start: completedAt - durationMs, end: completedAt };
        } else if (
          pendingStart !== undefined &&
          completedAt !== undefined &&
          completedAt > pendingStart
        ) {
          span = { start: pendingStart, end: completedAt };
        }
        pendingStart = undefined;

        if (!span) continue;
        note(span.start);
        note(span.end);
        turns++;
        raw.push(span);
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

  // The filename carries the session uuid, so a rollout whose session_meta line was
  // lost to a torn write is still identifiable.
  if (!sessionId) sessionId = FILENAME_ID_RE.exec(path.basename(tf.file))?.[1];
  if (!sessionId || first === undefined || last === undefined) {
    return { record: null, lines, parsed };
  }

  // Nothing in a rollout's path encodes the working directory, so unlike a Claude
  // transcript there is no slug to fall back on. Say unknown rather than guess.
  const workingDir = cwd ?? '(unknown)';
  const { project, label } = attribute(workingDir);

  const spans = mergeSpans(raw);
  const startedAt = Math.min(first, spans[0]?.start ?? first);
  const endedAt = Math.max(last, spans[spans.length - 1]?.end ?? last);

  const record: SessionRecord = {
    agent: CODEX_ID,
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

export const codexAdapter: AgentAdapter = {
  id: CODEX_ID,
  name: 'Codex',
  root: codexRoot,
  async detect(): Promise<boolean> {
    try {
      await stat(codexSessionsDir());
      return true;
    } catch {
      return false;
    }
  },
  list: listRollouts,
  parse: parseRollout,
  // No `live`: Codex keeps no registry of running sessions on disk. The only way to
  // fake one would be to call a recently-touched rollout "working", which invents a
  // status the agent never reported.
  // Phrased to follow the agent's name: "Codex: publishes no live session registry".
  liveNote: 'publishes no live session registry',
};
