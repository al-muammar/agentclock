import type { AgentAdapter } from './agents/index.js';
import type { SessionFile, SessionRecord } from './types.js';

export interface ScanOptions {
  /** Files already parsed and unchanged since — skipped entirely. */
  skip?: (file: SessionFile) => boolean;
  onProgress?: (done: number, total: number) => void;
  /** Files parsed at once. Bounded so a huge history can't exhaust file handles. */
  concurrency?: number;
}

/** What one agent contributed to a scan. */
export interface AgentScan {
  agent: string;
  name: string;
  found: number;
  scanned: number;
  /** Files the adapter cannot read at all, e.g. compressed rollouts. */
  unreadable: number;
  unreadableReason?: string;
}

export interface ScanResult {
  records: SessionRecord[];
  scanned: number;
  skipped: number;
  lines: number;
  parsedLines: number;
  /** Per-agent breakdown, for `--verbose` and for the empty-state message. */
  agents: AgentScan[];
}

interface Job {
  adapter: AgentAdapter;
  file: SessionFile;
}

/**
 * Parse every session file that isn't already known, across every selected agent.
 *
 * Agent-agnostic on purpose: the work queue is flat and interleaved across
 * adapters, so one agent with 5000 tiny rollouts cannot starve another with 40 large
 * transcripts, and the concurrency bound applies to the run rather than per agent.
 */
export async function scanSessions(
  adapters: readonly AgentAdapter[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const jobs: Job[] = [];
  const agents: AgentScan[] = [];
  let skipped = 0;

  for (const adapter of adapters) {
    let listing: Awaited<ReturnType<AgentAdapter['list']>>;
    try {
      listing = await adapter.list();
    } catch {
      listing = { files: [] };
    }

    const todo = options.skip ? listing.files.filter((f) => !options.skip!(f)) : listing.files;
    skipped += listing.files.length - todo.length;
    for (const file of todo) jobs.push({ adapter, file });

    const scan: AgentScan = {
      agent: adapter.id,
      name: adapter.name,
      found: listing.files.length,
      scanned: todo.length,
      unreadable: listing.unreadable?.count ?? 0,
    };
    if (listing.unreadable) scan.unreadableReason = listing.unreadable.reason;
    agents.push(scan);
  }

  const limit = Math.max(1, options.concurrency ?? 8);
  const records: SessionRecord[] = [];
  let lines = 0;
  let parsedLines = 0;
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index]!;
      try {
        const result = await job.adapter.parse(job.file);
        lines += result.lines;
        parsedLines += result.parsed;
        if (result.record) records.push(result.record);
      } catch {
        // unreadable session file — skip rather than abort the run
      }
      done++;
      options.onProgress?.(done, jobs.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));

  return { records, scanned: jobs.length, skipped, lines, parsedLines, agents };
}
