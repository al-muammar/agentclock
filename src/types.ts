/** A contiguous stretch of wall-clock time. Half-open: [start, end). */
export interface Span {
  start: number;
  end: number;
}

/**
 * Session status as reported by an agent's live registry.
 *
 * Claude Code's internal enum is busy | shell | idle | waiting, but the on-disk
 * format is explicitly internal and changes between versions, so unknown values are
 * carried through verbatim rather than coerced into a known one. The same rule
 * applies to any other agent that grows a registry.
 */
export type Status = 'busy' | 'waiting' | 'idle' | 'shell' | (string & {});

/** Statuses that mean an agent is doing work rather than sitting still. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['busy', 'shell']);

/** One live session, as published by an agent that keeps a registry on disk. */
export interface LiveSession {
  /** Which agent this session belongs to — `claude`, `codex`, … */
  agent: string;
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: Status;
  kind: string;
  /** Human-friendly session label, e.g. "no-tg-threads-84". */
  name?: string;
  /** Only present while status is "waiting", e.g. "input needed". */
  waitingFor?: string;
  version?: string;
  entrypoint?: string;
  /** Process start time as formatted by the agent; guards against PID reuse. */
  procStart?: string;
  updatedAt?: number;
  /** Timestamp of the last status transition. NOT a heartbeat — it does not tick. */
  statusUpdatedAt?: number;
}

/** A session reconstructed from whatever file its agent writes. */
export interface SessionRecord {
  /** Which agent produced this session — `claude`, `codex`, … */
  agent: string;
  sessionId: string;
  /** Working directory as recorded inside the session file. */
  cwd: string;
  /** Repo root, with `.claude/worktrees/<name>` folded away. */
  project: string;
  /** Display label — the worktree name when there is one, else the directory name. */
  label: string;
  /** Agent version that wrote the first record carrying one. */
  version?: string;
  /** First and last record timestamps: the session's lifetime. */
  startedAt: number;
  endedAt: number;
  /** Number of completed turns with an exact duration. */
  turns: number;
  /** Summed busy time, after merging overlaps. Exact, never estimated. */
  activeMs: number;
  /**
   * False when the session file carries no per-turn timing at all — Claude Code
   * transcripts before 2.1.222, or a Codex rollout old enough to predate the turn
   * events. Such sessions report no active time rather than a guess.
   */
  hasTurnData: boolean;
  /** Prompts actually typed by a human. */
  prompts: number;
  /** Merged busy spans. One session never overlaps itself. */
  spans: Span[];
  /** Source file, plus the stat used to skip it on a later run. */
  file: string;
  mtimeMs: number;
  size: number;
}

/**
 * One session file on disk, before it is parsed.
 *
 * Deliberately not called a transcript: Claude Code writes transcripts, Codex
 * writes rollouts, and the scanner does not care which.
 */
export interface SessionFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/** What an adapter returns for a single file. */
export interface ParseResult {
  record: SessionRecord | null;
  /** Lines read and lines that reached JSON.parse — used by --verbose. */
  lines: number;
  parsed: number;
}
