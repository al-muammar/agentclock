import type { LiveSession, ParseResult, SessionFile } from '../types.js';

/** What an adapter found on disk. */
export interface AgentListing {
  files: SessionFile[];
  /**
   * Files the adapter found but deliberately cannot read, and why.
   *
   * Silently dropping them would make the report look complete when it is not, so
   * the count is carried up and printed rather than swallowed.
   */
  unreadable?: { count: number; reason: string };
}

/**
 * One coding agent agentclock can read.
 *
 * The contract is deliberately narrow — find files, turn one into a session — so
 * that everything downstream (spans, stats, timeline, both renderers, the archive)
 * stays agent-agnostic. Adding an agent means adding one file here and one line to
 * the registry; nothing else in the tree should need to know its name.
 *
 * Two rules an adapter must respect, because the whole tool rests on them:
 *
 *  - **A session with N subagents counts as one.** Never emit a record for a
 *    subagent, a worker, or anything else that runs inside a session.
 *  - **Active time is exact or absent.** Spans must come from timing the agent
 *    itself recorded. If an agent publishes none, return `hasTurnData: false` and
 *    no spans; never reconstruct working time from gaps between messages.
 */
export interface AgentAdapter {
  /** Stable machine id. Appears in `--agent`, in the archive, and in output. */
  readonly id: string;
  /** Display name, e.g. "Claude Code". */
  readonly name: string;
  /** Directory this adapter reads. Shown by `agentclock agents`. */
  root(): string;
  /** True when this machine has anything for this agent. Never throws. */
  detect(): Promise<boolean>;
  /** Every session file worth parsing, excluding subagents. */
  list(): Promise<AgentListing>;
  /** Reconstruct one session from one file. */
  parse(file: SessionFile): Promise<ParseResult>;
  /**
   * Sessions running right now, for agents that publish their own state.
   * Omitted entirely when the agent keeps nothing on disk — a missing live source
   * is stated in the output, never faked from file mtimes.
   */
  live?(): Promise<LiveSession[]>;
  /** Why `live` is missing, phrased for the user. Required when `live` is absent. */
  readonly liveNote?: string;
}

/** What `agentclock agents` prints. */
export interface AgentInfo {
  id: string;
  name: string;
  root: string;
  present: boolean;
  live: boolean;
  liveNote?: string;
}
