import { attribute, type Anonymizer } from '../project.js';
import { duration, pad, padStart, truncate } from '../format.js';
import { ACTIVE_STATUSES, type LiveSession } from '../types.js';
import type { Stats } from '../stats.js';

const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY !== false;

const ESC = String.fromCharCode(27);
const code = (n: string) => (s: string) => (useColor ? `${ESC}[${n}m${s}${ESC}[0m` : s);

export const c = {
  busy: code('36'), // cyan — reads as the teal used throughout the dashboard
  waiting: code('33'), // amber
  idle: code('90'), // grey
  bold: code('1'),
  dim: code('2'),
  ink: code('39'),
};

function statusStyle(status: string): (s: string) => string {
  if (ACTIVE_STATUSES.has(status)) return c.busy;
  if (status === 'waiting') return c.waiting;
  if (status === 'idle') return c.idle;
  return c.waiting; // unknown status: make it visible rather than silently grey
}

/** The live three-way split, plus one line per running session. */
export function renderNow(sessions: LiveSession[], anon: Anonymizer): string {
  const now = Date.now();
  const lines: string[] = [];

  if (sessions.length === 0) {
    return `${c.dim('No Claude Code sessions are running.')}\n`;
  }

  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);

  const active = sessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length;
  const waiting = counts.get('waiting') ?? 0;
  const idle = counts.get('idle') ?? 0;
  const other = sessions.length - active - waiting - idle;

  const parts = [
    c.busy(`${active} working`),
    c.waiting(`${waiting} waiting on you`),
    c.idle(`${idle} idle`),
  ];
  if (other > 0) parts.push(c.waiting(`${other} unknown`));

  lines.push('');
  lines.push(
    `  ${c.bold(String(sessions.length))} ${sessions.length === 1 ? 'session' : 'sessions'} open   ${parts.join(c.dim(' · '))}`,
  );
  lines.push('');

  const rows = [...sessions].sort((a, b) => {
    const rank = (s: LiveSession) =>
      ACTIVE_STATUSES.has(s.status) ? 0 : s.status === 'waiting' ? 1 : 2;
    return rank(a) - rank(b) || a.startedAt - b.startedAt;
  });

  const nameWidth = Math.min(
    28,
    Math.max(12, ...rows.map((s) => (s.name ?? s.sessionId.slice(0, 8)).length)),
  );
  const projWidth = Math.min(
    26,
    Math.max(8, ...rows.map((s) => anon.projectLabel(attribute(s.cwd).project).length)),
  );

  lines.push(
    c.dim(
      `  ${pad('SESSION', nameWidth)}  ${pad('PROJECT', projWidth)}  ${pad('STATE', 9)}  ${padStart('UPTIME', 8)}`,
    ),
  );

  for (const s of rows) {
    const style = statusStyle(s.status);
    // The status marker occupies the first two columns, so the name gets the rest.
    const name = truncate(
      anon.session(s.name ?? s.sessionId.slice(0, 8), s.sessionId),
      nameWidth - 2,
    );
    const project = truncate(anon.projectLabel(attribute(s.cwd).project), projWidth);
    const state = s.status === 'waiting' && s.waitingFor ? 'waiting' : s.status;
    const uptime = duration(now - s.startedAt);
    const marker = ACTIVE_STATUSES.has(s.status) ? '●' : s.status === 'waiting' ? '◐' : '○';

    lines.push(
      `  ${style(marker)} ${pad(name, nameWidth - 2)}  ${c.dim(pad(project, projWidth))}  ${style(pad(state, 9))}  ${c.dim(padStart(uptime, 8))}`,
    );

    if (s.status === 'waiting' && s.waitingFor) {
      lines.push(`  ${' '.repeat(nameWidth)}  ${c.dim(`↳ ${s.waitingFor}`)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Compact historical summary for the terminal. */
export function renderStats(stats: Stats, anon: Anonymizer, limit = 8): string {
  const { summary } = stats;
  const lines: string[] = [];

  if (summary.sessions === 0) {
    return `${c.dim('No sessions found in the selected window.')}\n`;
  }

  lines.push('');
  lines.push(
    `  ${c.bold(String(summary.sessions))} sessions   ${c.bold(duration(summary.activeMs))} of agent work   ` +
      `${c.dim(`across ${duration(summary.coveredMs)} of wall clock`)}`,
  );
  lines.push(
    `  ${c.dim(`peak ${summary.peakConcurrency} at once · ${summary.parallelism.toFixed(2)}× parallel · ${summary.turns} turns · ${summary.projects} projects`)}`,
  );
  lines.push('');

  if (stats.concurrency.length > 0) {
    lines.push(c.dim('  TIME AT EACH LEVEL OF SIMULTANEOUS WORK'));
    const max = Math.max(...stats.concurrency.map((b) => b.ms));
    for (const bucket of stats.concurrency) {
      const width = Math.max(1, Math.round((bucket.ms / max) * 38));
      lines.push(
        `  ${padStart(String(bucket.level), 3)} busy  ${c.busy('█'.repeat(width))} ${c.dim(duration(bucket.ms))}`,
      );
    }
    lines.push('');
  }

  if (stats.projects.length > 0) {
    lines.push(c.dim('  BY PROJECT'));
    const top = stats.projects.slice(0, limit);
    const width = Math.min(30, Math.max(...top.map((p) => anon.projectLabel(p.project).length)));
    for (const p of top) {
      lines.push(
        `  ${pad(truncate(anon.projectLabel(p.project), width), width)}  ${padStart(duration(p.activeMs), 9)}  ${c.dim(`${p.sessions} sessions`)}`,
      );
    }
    if (stats.projects.length > limit) {
      lines.push(c.dim(`  … and ${stats.projects.length - limit} more`));
    }
    lines.push('');
  }

  if (summary.sessionsWithoutTurnData > 0) {
    lines.push(
      c.dim(
        `  ${summary.sessionsWithoutTurnData} session(s) predate Claude Code 2.1.222 and record no turn\n` +
          `  durations; they are counted but contribute no active time.`,
      ),
    );
    lines.push('');
  }

  return lines.join('\n');
}
