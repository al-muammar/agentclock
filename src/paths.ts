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

/** Claude Code transcripts: `<root>/projects/<slug>/<sessionId>.jsonl`. */
export function claudeProjectsDir(): string {
  return path.join(claudeRoot(), 'projects');
}

/** Claude Code's live session registry: `<root>/sessions/<pid>.json`. */
export function claudeSessionsDir(): string {
  return path.join(claudeRoot(), 'sessions');
}

/**
 * Root of the Codex config directory.
 *
 * CODEX_HOME is Codex's own relocation knob and plays the same role as
 * CLAUDE_CONFIG_DIR, so it gets the same treatment.
 */
export function codexRoot(): string {
  const override = process.env['CODEX_HOME'];
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(homedir(), '.codex');
}

/** Codex rollouts: `<root>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. */
export function codexSessionsDir(): string {
  return path.join(codexRoot(), 'sessions');
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

/** Default output location for the dashboard. */
export function defaultReportPath(): string {
  return path.join(agentclockDir(), 'dashboard.html');
}

/** Default output location for the shareable one-page PDF. */
export function defaultOnePagerPath(): string {
  return path.join(agentclockDir(), 'one-pager.pdf');
}
