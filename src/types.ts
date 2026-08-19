/** A contiguous stretch of wall-clock time. Half-open: [start, end). */
export interface Span {
  start: number;
  end: number;
}

/**
 * Session status as reported by Claude Code's live registry.
 *
 * The enum inside the Claude Code binary is busy | shell | idle | waiting, but the
 * on-disk format is explicitly internal and changes between versions, so unknown
 * values are carried through verbatim rather than coerced into a known one.
 */
export type Status = 'busy' | 'waiting' | 'idle' | 'shell' | (string & {});

/** Statuses that mean an agent is doing work rather than sitting still. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['busy', 'shell']);

/** Session kinds that are infrastructure rather than someone's coding session. */
export const EXCLUDED_KINDS: ReadonlySet<string> = new Set(['daemon', 'daemon-worker']);

/** One entry in `~/.claude/sessions/<pid>.json`, after liveness filtering. */
export interface LiveSession {
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
  /** Process start time as formatted by Claude Code; guards against PID reuse. */
  procStart?: string;
  updatedAt?: number;
  /** Timestamp of the last status transition. NOT a heartbeat — it does not tick. */
  statusUpdatedAt?: number;
}

/**
 * One subagent transcript belonging to a live session.
 *
 * Claude Code keeps no registry for agents — there is a file per session and
 * nothing per agent — so this is reconstructed from the transcript the agent
 * writes. See subagents.ts for how `running` is decided.
 */
export interface LiveSubagent {
  /** The id in the filename, `agent-<agentId>.jsonl`. Opaque, not a name. */
  agentId: string;
  /** Agent type as Claude Code recorded it, e.g. "Explore". Absent on old files. */
  agentType?: string;
  /** First record timestamp. Only resolved for agents that are still running. */
  startedAt?: number;
  /** Last write to the transcript. */
  lastWriteAt: number;
  running: boolean;
}

/**
 * Is this session doing work?
 *
 * Wider than `ACTIVE_STATUSES` on purpose: a session can sit `waiting` or `idle`
 * while a background subagent grinds away, and calling that "not working" makes
 * the agent count describe sessions the session count does not include.
 *
 * `ACTIVE_STATUSES` itself stays exactly as it is — it describes Claude Code's
 * status field, unknown values and all, and this builds on top rather than
 * widening it.
 */
export function isWorking(session: LiveSession, agents: LiveSubagent[] = []): boolean {
  return ACTIVE_STATUSES.has(session.status) || agents.some((a) => a.running);
}

/** A session reconstructed from its transcript. */
export interface SessionRecord {
  sessionId: string;
  /** Working directory as recorded inside the transcript. */
  cwd: string;
  /** Repo root, with `.claude/worktrees/<name>` folded away. */
  project: string;
  /** Display label — the worktree name when there is one, else the directory name. */
  label: string;
  /** Claude Code version that wrote the first record carrying one. */
  version?: string;
  /** First and last record timestamps: the session's lifetime. */
  startedAt: number;
  endedAt: number;
  /** Number of completed turns with an exact duration. */
  turns: number;
  /** Summed busy time, after merging overlaps. Exact, never estimated. */
  activeMs: number;
  /**
   * False when the transcript predates Claude Code 2.1.222, which introduced the
   * turn_duration record. Such sessions report no active time rather than a guess.
   */
  hasTurnData: boolean;
  /** Prompts actually typed by a human (records carrying `promptSource`). */
  prompts: number;
  /** Merged busy spans. One session never overlaps itself. */
  spans: Span[];
  /** Source file, plus the stat used to skip it on a later run. */
  file: string;
  mtimeMs: number;
  size: number;
}

/** What the transcript scanner returns for a single file. */
export interface ParseResult {
  record: SessionRecord | null;
  /** Lines read and lines that reached JSON.parse — used by --verbose. */
  lines: number;
  parsed: number;
}
