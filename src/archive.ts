import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_ID } from './agents/index.js';
import { archivePath, agentclockDir } from './paths.js';
import type { SessionRecord, Span } from './types.js';

/**
 * On-disk shape. Spans are stored as [start, end] pairs rather than objects —
 * roughly a third the bytes, and the file is written in full on every run.
 *
 * `v: 1` predates multi-agent support and has no `agent` field; every such record
 * is a Claude Code session, because that is all the tool could read. Those lines
 * still load, and get rewritten as v2 on the next save.
 */
interface ArchivedSession {
  v: 1 | 2;
  /** Absent in v1. */
  agent?: string;
  sessionId: string;
  cwd: string;
  project: string;
  label: string;
  version?: string;
  startedAt: number;
  endedAt: number;
  turns: number;
  activeMs: number;
  hasTurnData: boolean;
  prompts: number;
  spans: Array<[number, number]>;
  file: string;
  mtimeMs: number;
  size: number;
}

const ARCHIVE_VERSION = 2;

export interface Archive {
  /** Every session ever seen, including ones whose file has been deleted. */
  bySession: Map<string, SessionRecord>;
  /** Lets a scan skip files that have not changed since they were parsed. */
  byFile: Map<string, { mtimeMs: number; size: number }>;
}

export function emptyArchive(): Archive {
  return { bySession: new Map(), byFile: new Map() };
}

/**
 * Archive key.
 *
 * Namespaced by agent rather than bare session id: two agents pick their own ids
 * with no coordination, and one colliding pair would silently merge two unrelated
 * sessions into one.
 */
export function sessionKey(record: { agent: string; sessionId: string }): string {
  return `${record.agent}:${record.sessionId}`;
}

function toRecord(a: ArchivedSession): SessionRecord {
  const spans: Span[] = a.spans.map(([start, end]) => ({ start, end }));
  const record: SessionRecord = {
    agent: a.agent ?? CLAUDE_ID,
    sessionId: a.sessionId,
    cwd: a.cwd,
    project: a.project,
    label: a.label,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    turns: a.turns,
    activeMs: a.activeMs,
    hasTurnData: a.hasTurnData,
    prompts: a.prompts,
    spans,
    file: a.file,
    mtimeMs: a.mtimeMs,
    size: a.size,
  };
  if (a.version) record.version = a.version;
  return record;
}

function toArchived(r: SessionRecord): ArchivedSession {
  const a: ArchivedSession = {
    v: ARCHIVE_VERSION,
    agent: r.agent,
    sessionId: r.sessionId,
    cwd: r.cwd,
    project: r.project,
    label: r.label,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    turns: r.turns,
    activeMs: r.activeMs,
    hasTurnData: r.hasTurnData,
    prompts: r.prompts,
    spans: r.spans.map((s) => [s.start, s.end]),
    file: r.file,
    mtimeMs: r.mtimeMs,
    size: r.size,
  };
  if (r.version) a.version = r.version;
  return a;
}

/**
 * Load previously recorded sessions.
 *
 * This is what makes a stateless tool durable. Claude Code deletes transcripts
 * after `cleanupPeriodDays` (default 30), so without an archive the history
 * silently truncates. A malformed line is skipped rather than failing the run —
 * a corrupt archive must never make the tool unusable.
 */
export async function loadArchive(): Promise<Archive> {
  const archive = emptyArchive();
  let text: string;
  try {
    text = await readFile(archivePath(), 'utf8');
  } catch {
    return archive;
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ArchivedSession;
      if (!parsed?.sessionId) continue;
      // Refuse a version from the future rather than misread its fields.
      if (parsed.v !== 1 && parsed.v !== 2) continue;
      const record = toRecord(parsed);
      archive.bySession.set(sessionKey(record), record);
      archive.byFile.set(record.file, { mtimeMs: record.mtimeMs, size: record.size });
    } catch {
      // skip the bad line, keep the rest
    }
  }
  return archive;
}

/** Prefer whichever view of a session saw more of it. */
function newer(a: SessionRecord, b: SessionRecord): SessionRecord {
  if (b.turns !== a.turns) return b.turns > a.turns ? b : a;
  if (b.endedAt !== a.endedAt) return b.endedAt > a.endedAt ? b : a;
  return b.mtimeMs >= a.mtimeMs ? b : a;
}

/** Merge freshly parsed sessions over the archive, keeping the fuller record. */
export function mergeArchive(archive: Archive, fresh: SessionRecord[]): SessionRecord[] {
  const merged = new Map(archive.bySession);
  for (const record of fresh) {
    const key = sessionKey(record);
    const existing = merged.get(key);
    merged.set(key, existing ? newer(existing, record) : record);
  }
  return [...merged.values()];
}

/**
 * Write the archive atomically.
 *
 * Rewritten in full rather than appended: the file is small (a few hundred KB for
 * a year of sessions) and rewriting keeps it deduplicated, which an append log
 * would not. Temp file plus rename so an interrupted write cannot truncate the
 * existing archive.
 */
export async function saveArchive(records: SessionRecord[]): Promise<void> {
  const dir = agentclockDir();
  await mkdir(dir, { recursive: true });

  const body = records
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => JSON.stringify(toArchived(r)))
    .join('\n');

  const target = archivePath();
  const temp = path.join(dir, `.archive.${process.pid}.tmp`);
  await writeFile(temp, body ? `${body}\n` : '', 'utf8');
  await rename(temp, target);
}
