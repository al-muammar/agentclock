import { createHash } from 'node:crypto';
import path from 'node:path';

export interface Attribution {
  /** Repo root — what work gets grouped under. */
  project: string;
  /** Display label for this particular session. */
  label: string;
}

/** Matches the worktree directory Claude Code creates: `<repo>/.claude/worktrees/<name>`. */
const WORKTREE_RE = /^(.*)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/;

/**
 * Attribute a working directory to a project.
 *
 * Worktree sessions run in `<repo>/.claude/worktrees/<name>`, so attributing them
 * by cwd alone shatters one repository into a dozen phantom projects. Fold the
 * worktree away for grouping, but keep its name — it is usually the best one-line
 * description of what that session was for.
 */
export function attribute(cwd: string): Attribution {
  const normalized = cwd.replace(/\/+$/, '');
  const m = WORKTREE_RE.exec(normalized);
  if (m?.[1] && m[2]) {
    return { project: m[1], label: m[2] };
  }
  return { project: normalized, label: path.basename(normalized) || normalized };
}

/** Short, stable, content-derived token. Same input always yields the same label. */
function token(prefix: string, value: string): string {
  const h = createHash('sha256').update(value).digest('hex').slice(0, 6);
  return `${prefix}-${h}`;
}

/**
 * Replaces identifying names with stable pseudonyms.
 *
 * Repository paths and worktree names are client names, and a report is meant to be
 * shared. Hash-derived rather than sequential so the same project keeps the same
 * label across runs and across machines.
 */
export class Anonymizer {
  constructor(readonly enabled: boolean) {}

  project(p: string): string {
    return this.enabled ? token('project', p) : p;
  }

  /** Project label shown in charts — the basename, or a pseudonym. */
  projectLabel(p: string): string {
    return this.enabled ? token('project', p) : path.basename(p) || p;
  }

  session(label: string, sessionId: string): string {
    return this.enabled ? token('session', sessionId) : label;
  }
}
