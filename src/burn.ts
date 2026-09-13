import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parentTranscript, subagentsDir } from './subagents.js';
import type { LiveSession } from './types.js';

/** Substring prefilter. Only assistant records carry a usage object. */
const USAGE_MARKER = '"usage"';

/**
 * How many recent message ids to remember for deduplication.
 *
 * Claude Code writes a record per streaming update, so one message can appear many
 * times with a growing output_tokens, and summing them all overcounts output by
 * 145% across the author's corpus. Measured across 612 transcripts, 67,376 of
 * 67,377 duplicate ids were contiguous — only one ever resumed after a gap — so a
 * small window is enough and the reader stays O(1) in memory.
 */
const RECENT_IDS = 64;

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** Assistant messages counted, after deduplication. */
  messages: number;
}

export interface SessionBurn extends TokenTotals {
  sessionId: string;
  /** Of the totals above, the part contributed by subagents inside this session. */
  subagentOutput: number;
}

/** Per-file reading position, so a refresh only pays for what is new. */
export interface BurnCursor {
  offset: number;
  recentIds: string[];
  totals: TokenTotals;
}

export type BurnState = Record<string, BurnCursor>;

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 };
}

function add(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheCreation += from.cacheCreation;
  into.cacheRead += from.cacheRead;
  into.messages += from.messages;
}

/**
 * Fold one transcript line into the totals.
 *
 * `recent` is mutated: it is the sliding dedup window described above.
 */
function consume(line: string, totals: TokenTotals, recent: string[]): void {
  if (line.length < 2 || !line.includes(USAGE_MARKER)) return;

  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // A torn final line during an active write. Skipping it costs one message.
    return;
  }

  const message = (record as { message?: Record<string, unknown> }).message;
  if (!message || typeof message !== 'object') return;
  const usage = message['usage'];
  if (!usage || typeof usage !== 'object') return;

  const id = message['id'];
  if (typeof id === 'string') {
    if (recent.includes(id)) return;
    recent.push(id);
    if (recent.length > RECENT_IDS) recent.shift();
  }

  const u = usage as Record<string, unknown>;
  const n = (key: string): number => {
    const value = u[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  totals.input += n('input_tokens');
  totals.output += n('output_tokens');
  totals.cacheCreation += n('cache_creation_input_tokens');
  totals.cacheRead += n('cache_read_input_tokens');
  totals.messages += 1;
}

/**
 * Read a transcript from where we left off and fold the new records in.
 *
 * Only whole lines are consumed; a trailing partial line is left for the next
 * pass, because a live session is being written to while this runs. Returns the
 * updated cursor, or the one it was given when the file has not grown.
 */
export async function readBurn(file: string, prior?: BurnCursor): Promise<BurnCursor> {
  const cursor: BurnCursor = prior
    ? { offset: prior.offset, recentIds: [...prior.recentIds], totals: { ...prior.totals } }
    : { offset: 0, recentIds: [], totals: emptyTotals() };

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return cursor;
  }

  // Truncated or replaced — a new session reusing the path, or a rotated file.
  // Start over rather than reporting totals from a file that no longer exists.
  if (size < cursor.offset) {
    cursor.offset = 0;
    cursor.recentIds = [];
    cursor.totals = emptyTotals();
  }
  if (size === cursor.offset) return cursor;

  const stream = createReadStream(file, { start: cursor.offset, end: size - 1 });

  let pending = '';
  let consumed = 0;
  try {
    for await (const chunk of stream) {
      pending += (chunk as Buffer).toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        consume(line, cursor.totals, cursor.recentIds);
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
  } catch {
    // Unreadable mid-stream: keep whatever we folded in and the offset for it.
  } finally {
    stream.destroy();
  }

  cursor.offset += consumed;
  return cursor;
}

/**
 * Token burn for each live session, subagents rolled into their parent.
 *
 * Rolling subagent tokens up is what keeps the count honest without touching the
 * rule that a session with N subagents is one session: no new session appears
 * here, and nothing downstream of stats.ts sees any of this. Tokens are additive
 * in a way concurrency is not, and leaving them out understated spend by a quarter
 * when measured across the author's corpus.
 */
export async function readSessionBurn(
  sessions: LiveSession[],
  state: BurnState = {},
): Promise<{ burn: SessionBurn[]; state: BurnState }> {
  const next: BurnState = {};
  const burn: SessionBurn[] = [];

  for (const session of sessions) {
    const totals = emptyTotals();

    const parent = parentTranscript(session);
    const parentCursor = await readBurn(parent, state[parent]);
    next[parent] = parentCursor;
    add(totals, parentCursor.totals);

    let subagentOutput = 0;
    const dir = subagentsDir(session);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry);
      const cursor = await readBurn(file, state[file]);
      next[file] = cursor;
      add(totals, cursor.totals);
      subagentOutput += cursor.totals.output;
    }

    burn.push({ sessionId: session.sessionId, subagentOutput, ...totals });
  }

  return { burn, state: next };
}

/** Sum of several sessions' burn — the "overall number" the badge leads with. */
export function totalBurn(burn: SessionBurn[]): TokenTotals {
  const total = emptyTotals();
  for (const b of burn) add(total, b);
  return total;
}
