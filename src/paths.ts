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

/** Where cctrack keeps its own accumulated history. */
export function cctrackDir(): string {
  const override = process.env['CCTRACK_DIR'];
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(homedir(), '.cctrack');
}

export function archivePath(): string {
  return path.join(cctrackDir(), 'archive.jsonl');
}

/** Default output location for the dashboard. */
export function defaultReportPath(): string {
  return path.join(cctrackDir(), 'dashboard.html');
}
