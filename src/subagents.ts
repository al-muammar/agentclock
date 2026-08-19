import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDir } from './paths.js';
import type { LiveSession, LiveSubagent } from './types.js';

/**
 * Directory name Claude Code derives from a working directory.
 *
 * Every character that is not alphanumeric becomes `-`, which reproduced 380 of
 * the 387 project directories on the author's machine; the misses are sessions
 * resumed from a different cwd, not a different rule. The mapping is lossy and
 * cannot be reversed — see transcripts.ts — but this direction is all we need.
 *
 * Deriving beats searching: the alternative is stat-ing `<sessionId>` under all
 * 400+ project slugs, once per session, on a two-second refresh.
 */
export function slugFor(cwd: string): string {
  return cwd.replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

/** `<root>/projects/<slug>/<sessionId>/subagents` — one level below the transcript. */
export function subagentsDir(session: Pick<LiveSession, 'cwd' | 'sessionId'>): string {
  return path.join(projectsDir(), slugFor(session.cwd), session.sessionId, 'subagents');
}

/** The parent session transcript, `<root>/projects/<slug>/<sessionId>.jsonl`. */
export function parentTranscript(session: Pick<LiveSession, 'cwd' | 'sessionId'>): string {
  return path.join(projectsDir(), slugFor(session.cwd), `${session.sessionId}.jsonl`);
}

/**
 * How long an agent may go without writing before we stop counting it.
 *
 * Measured, not guessed: across 474 real subagent transcripts the longest gap
 * between consecutive records inside a single run was 1626s, and p99 was 77s. A
 * cap of 30 minutes therefore never cuts off a working agent, while it does stop
 * an aborted one — whose transcript has no terminal record and never will —
 * counting for the rest of the session's life.
 *
 * This is not a freshness test. "Wrote within the last 60s" was measured at a
 * 21% time-weighted false-negative rate, because a thinking agent or a long Bash
 * is silent for minutes; that is why the terminal-record and completion checks
 * below exist and this is only a backstop.
 */
export const STALE_CAP_MS = 30 * 60_000;

/** Bytes read from the end of a transcript to find its last complete record. */
const TAIL_WINDOW = 256 * 1024;

/**
 * Bytes read from the end of a parent transcript on a cold start.
 *
 * Only completions inside STALE_CAP_MS can matter — an older one belongs to an
 * agent already dropped by the cap — so the window only has to cover the last
 * half hour of records. Later polls read just the bytes appended since.
 */
const PARENT_WINDOW = 4 * 1024 * 1024;

/** Read at most `length` bytes ending at `end`. Returns '' if the file is gone. */
async function readWindow(file: string, start: number, length: number): Promise<string> {
  if (length <= 0) return '';
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Last complete line of a chunk read from `offset`, or null if there is none. */
function lastCompleteLine(chunk: string, offset: number): string | null {
  const lines = chunk.split('\n').filter((l) => l.length > 0);
  // A window that does not start at byte 0 almost certainly cuts the first line.
  if (offset > 0 && lines.length > 1) lines.shift();
  return lines[lines.length - 1] ?? null;
}

/**
 * Does this record mean the agent returned?
 *
 * A subagent's loop ends when the model answers without asking for another tool,
 * which is an assistant record with `stop_reason: "end_turn"` and no tool_use in
 * its content. 407 of 474 transcripts end exactly that way.
 *
 * The other 67 end on `stop_reason: null` or `stop_sequence`, and 43 of those had
 * in fact finished — which is what the parent's completion notification is for.
 * Anything unrecognised is deliberately *not* terminal: over-reporting an agent is
 * the cheap mistake, hiding one is not.
 */
export function isTerminalRecord(line: string): boolean {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false; // torn write, mid-append
  }
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  if (r['type'] !== 'assistant') return false;

  const message = r['message'];
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m['stop_reason'] !== 'end_turn') return false;

  const content = m['content'];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'tool_use'
      ) {
        return false; // still holding a tool call open
      }
    }
  }
  return true;
}

/** Agent type — "Explore", "general-purpose", … — as recorded on the record. */
function agentTypeOf(line: string): string | undefined {
  const m = /"attributionAgent":"([^"]*)"/.exec(line);
  return m?.[1];
}

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

/** First record timestamp: when the agent was spawned. */
function firstTimestamp(head: string): number | undefined {
  for (const line of head.split('\n')) {
    const m = TIMESTAMP_RE.exec(line);
    if (!m?.[1]) continue;
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Agent ids the parent has been told are finished, from one chunk of transcript. */
function completedIdsIn(chunk: string, into: Set<string>): void {
  // The parent records `<task-notification>` blocks carrying the agent id and a
  // status. Both `completed` and `failed` mean the agent is no longer running.
  const re = /<task-id>([^<]+)<\/task-id>[\s\S]{0,2000}?<status>([^<]+)<\/status>/g;
  for (const m of chunk.matchAll(re)) {
    const id = m[1];
    const status = m[2];
    if (id && status && status !== 'running') into.add(id);
  }
}

interface ParentScan {
  size: number;
  ids: Set<string>;
}

/**
 * Completion notifications seen in a parent transcript, cached across polls.
 *
 * Keyed by path and grown incrementally: a poll reads only the bytes appended
 * since the last one, so a session that runs for hours costs one bounded read at
 * the start and a few kilobytes thereafter.
 */
const parentScans = new Map<string, ParentScan>();

async function completedAgentIds(file: string): Promise<Set<string>> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Set(); // no transcript: nothing has been reported finished
  }

  const known = parentScans.get(file);
  // A shrunk file is a different file — start over rather than trust the offset.
  const from = known && known.size <= size ? known.size : Math.max(0, size - PARENT_WINDOW);
  const ids = known && known.size <= size ? known.ids : new Set<string>();

  if (size > from) {
    // Overlap the previous read a little: a notification block straddling the
    // boundary would otherwise be split in half and matched by neither pass.
    const start = Math.max(0, from - 4096);
    try {
      completedIdsIn(await readWindow(file, start, size - start), ids);
    } catch {
      // Unreadable parent: report nothing finished, which counts agents as running.
    }
  }

  parentScans.set(file, { size, ids });
  return ids;
}

/** Drop cached parent scans for sessions that are no longer live. */
function forgetDeadParents(liveFiles: Set<string>): void {
  for (const file of parentScans.keys()) {
    if (!liveFiles.has(file)) parentScans.delete(file);
  }
}

const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;

/**
 * Every subagent transcript belonging to one live session, with a verdict.
 *
 * An agent counts as running when nothing says it stopped: no terminal record, no
 * completion notification in the parent, and a write inside the stale cap. Every
 * failure path — missing directory, unreadable file, unparsable record — leaves
 * `running` true, matching registry.ts: showing a phantom is far cheaper than
 * hiding real work.
 */
export async function readLiveSubagents(
  session: Pick<LiveSession, 'cwd' | 'sessionId'>,
  now = Date.now(),
): Promise<LiveSubagent[]> {
  const dir = subagentsDir(session);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // this session never spawned an agent
  }

  const agents: LiveSubagent[] = [];
  const candidates: LiveSubagent[] = [];

  for (const entry of entries) {
    const match = AGENT_FILE_RE.exec(entry);
    if (!match?.[1]) continue;
    const file = path.join(dir, entry);

    let mtimeMs: number;
    let size: number;
    try {
      const st = await stat(file);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      continue; // deleted between readdir and stat
    }

    const agent: LiveSubagent = {
      agentId: match[1],
      lastWriteAt: mtimeMs,
      running: true,
    };

    if (now - mtimeMs > STALE_CAP_MS) {
      agent.running = false;
      agents.push(agent);
      continue;
    }

    const offset = Math.max(0, size - TAIL_WINDOW);
    let tail: string | null = null;
    try {
      tail = lastCompleteLine(await readWindow(file, offset, size - offset), offset);
    } catch {
      // Unreadable: fall through as running.
    }

    if (tail) {
      const type = agentTypeOf(tail);
      if (type) agent.agentType = type;
      if (isTerminalRecord(tail)) agent.running = false;
    }

    agents.push(agent);
    if (agent.running) candidates.push(agent);
  }

  if (candidates.length > 0) {
    const finished = await completedAgentIds(parentTranscript(session));
    for (const agent of candidates) {
      if (finished.has(agent.agentId)) agent.running = false;
    }

    // Only a still-running agent needs a start time, and it costs a second read.
    for (const agent of candidates) {
      if (!agent.running) continue;
      try {
        const head = await readWindow(path.join(dir, `agent-${agent.agentId}.jsonl`), 0, 64 * 1024);
        const started = firstTimestamp(head);
        if (started !== undefined) agent.startedAt = started;
        // The opening record is the prompt and carries no type; the reply does.
        // Only worth looking when the tail did not already say.
        if (agent.agentType === undefined) {
          const type = agentTypeOf(head);
          if (type) agent.agentType = type;
        }
      } catch {
        // No start time is a missing detail, never a reason to drop the agent.
      }
    }
  }

  agents.sort((a, b) => (a.startedAt ?? a.lastWriteAt) - (b.startedAt ?? b.lastWriteAt));
  return agents;
}

/** Running subagents for every live session, keyed by session id. */
export async function readLiveSubagentsFor(
  sessions: LiveSession[],
  now = Date.now(),
): Promise<Map<string, LiveSubagent[]>> {
  const bySession = new Map<string, LiveSubagent[]>();
  const live = new Set<string>();

  for (const session of sessions) {
    live.add(parentTranscript(session));
    bySession.set(session.sessionId, await readLiveSubagents(session, now));
  }

  forgetDeadParents(live);
  return bySession;
}
