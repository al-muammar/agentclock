import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Root of the Claude Code config directory.
 *
 * CLAUDE_CONFIG_DIR relocates the whole tree, so honour it rather than assuming
 * ~/.claude — users who set it would otherwise get an empty report with no
 * explanation.
 */
export function claudeRoot(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(homedir(), '.claude');
}

/** Transcripts: `<root>/projects/<slug>/<sessionId>.jsonl`. */
export function projectsDir(): string {
  return path.join(claudeRoot(), 'projects');
}

/** Live session registry: `<root>/sessions/<pid>.json`. */
export function sessionsDir(): string {
  return path.join(claudeRoot(), 'sessions');
}

/** Where agentclock keeps its own accumulated history. */
export function agentclockDir(): string {
  const override = process.env['AGENTCLOCK_DIR'];
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(homedir(), '.agentclock');
}

export function archivePath(): string {
  return path.join(agentclockDir(), 'archive.jsonl');
}

/**
 * Last known quota snapshot, plus the per-session burn that goes with it.
 *
 * Written by the CLI, read by the menu bar app. Percentages, reset times and token
 * counts only — never a credential. Kept small on purpose: the menu bar parses it
 * every two seconds, so the reading cursors live in their own file rather than
 * bloating this one.
 */
export function quotaCachePath(): string {
  return path.join(agentclockDir(), 'usage.json');
}

/**
 * Per-file reading positions for the token burn.
 *
 * Internal bookkeeping, and an order of magnitude larger than the snapshot it
 * supports, which is exactly why nothing on the display path reads it.
 */
export function burnStatePath(): string {
  return path.join(agentclockDir(), 'burn-state.json');
}

/** Default output location for the dashboard. */
export function defaultReportPath(): string {
  return path.join(agentclockDir(), 'dashboard.html');
}

/** Default output location for the shareable one-page PDF. */
export function defaultOnePagerPath(): string {
  return path.join(agentclockDir(), 'one-pager.pdf');
}
