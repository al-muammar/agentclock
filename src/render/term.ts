import { attribute, type Anonymizer } from '../project.js';
import {
  FULL_DAY,
  clockFromFraction,
  duration,
  pad,
  padStart,
  truncate,
  type HourRange,
} from '../format.js';
import { ACTIVE_STATUSES, isWorking, type LiveSession, type LiveSubagent } from '../types.js';
import type { Stats } from '../stats.js';

const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY !== false;

export const ESC = String.fromCharCode(27);
/** Home the cursor and clear everything below — a flicker-free redraw for watch. */
export const CLEAR_SCREEN = `${ESC}[H${ESC}[J`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
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
export function renderNow(
  sessions: LiveSession[],
  anon: Anonymizer,
  subagents: Map<string, LiveSubagent[]> = new Map(),
): string {
  const now = Date.now();
  const lines: string[] = [];

  if (sessions.length === 0) {
    return `${c.dim('No Claude Code sessions are running.')}\n`;
  }

  const running = (s: LiveSession) => (subagents.get(s.sessionId) ?? []).filter((a) => a.running);

  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);

  // "Working" counts a session whose only worker is a background agent, so the
  // agent tally can never describe sessions this number leaves out.
  const active = sessions.filter((s) => isWorking(s, running(s))).length;
  const agents = sessions.reduce((sum, s) => sum + running(s).length, 0);
  const waiting = counts.get('waiting') ?? 0;
  const idle = counts.get('idle') ?? 0;
  const other =
    sessions.length - (counts.get('busy') ?? 0) - (counts.get('shell') ?? 0) - waiting - idle;

  const parts = [
    c.busy(`${active} working`),
    c.waiting(`${waiting} waiting on you`),
    c.idle(`${idle} idle`),
  ];
  if (other > 0) parts.push(c.waiting(`${other} unknown`));
  if (agents > 0) parts.push(c.busy(`${agents} ${agents === 1 ? 'agent' : 'agents'}`));

  lines.push('');
  lines.push(
    `  ${c.bold(String(sessions.length))} ${sessions.length === 1 ? 'session' : 'sessions'} open   ${parts.join(c.dim(' · '))}`,
  );
  lines.push('');

  const rows = [...sessions].sort((a, b) => {
    const rank = (s: LiveSession) =>
      isWorking(s, running(s)) ? 0 : s.status === 'waiting' ? 1 : 2;
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

  const showAgents = agents > 0;
  const agentCol = showAgents ? `  ${padStart('AGENTS', 6)}` : '';

  lines.push(
    c.dim(
      `  ${pad('SESSION', nameWidth)}  ${pad('PROJECT', projWidth)}  ${pad('STATE', 9)}  ${padStart('UPTIME', 8)}${agentCol}`,
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
    const mine = running(s);
    const working = isWorking(s, mine);
    const marker = working ? '●' : s.status === 'waiting' ? '◐' : '○';
    // The marker says whether work is happening, the STATE column says what the
    // session itself reports. A session can be idle with a live agent, and both
    // halves of that are worth seeing.
    const markerStyle = working ? c.busy : style;
    const tally = showAgents
      ? `  ${c.busy(padStart(mine.length > 0 ? String(mine.length) : '·', 6))}`
      : '';

    lines.push(
      `  ${markerStyle(marker)} ${pad(name, nameWidth - 2)}  ${c.dim(pad(project, projWidth))}  ${style(pad(state, 9))}  ${c.dim(padStart(uptime, 8))}${tally}`,
    );

    if (s.status === 'waiting' && s.waitingFor) {
      lines.push(`  ${' '.repeat(nameWidth)}  ${c.dim(`↳ ${s.waitingFor}`)}`);
    }

    // One line per running agent, indented under its session. Type and elapsed
    // time only — an agent's prompt is the user's own work, and this output gets
    // pasted into issues and chats.
    for (const agent of mine) {
      const label = truncate(agent.agentType ?? 'agent', nameWidth - 4);
      const since = agent.startedAt ?? agent.lastWriteAt;
      lines.push(
        `    ${c.busy('└')} ${pad(label, nameWidth - 4)}  ${' '.repeat(projWidth)}  ${c.dim(pad('running', 9))}  ${c.dim(padStart(duration(now - since), 8))}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Per-day activity timeline for the terminal.
 *
 * Each row is one day split into equal-width cells; the block character encodes
 * how much of that cell had an agent working, so a burst is visible even when a
 * cell covers 30 minutes. Ramp characters carry the magnitude, colour only
 * reinforces it — this stays readable piped to a file or on a mono terminal.
 */
export function renderTimeline(
  stats: Stats,
  columns = 72,
  window: HourRange | null = null,
): string {
  if (stats.timeline.length === 0) {
    return `${c.dim('No agent activity in the selected window.')}\n`;
  }

  const view = window ?? FULL_DAY;
  const cells = Math.max(24, Math.min(columns, 144));
  const ramp = [' ', '▁', '▃', '▅', '▇', '█'];

  const lines: string[] = [''];
  lines.push(
    c.dim(
      `  Each row is one day · ${cells} cells · ${clockFromFraction(view.from)} to ${clockFromFraction(view.to)} (local)`,
    ),
  );
  lines.push('');

  // Hour ruler, aligned to the cell grid and to whatever window is in view.
  const spanHours = (view.to - view.from) * 24;
  const tickHours = spanHours > 12 ? 3 : spanHours > 4 ? 1 : spanHours > 1 ? 0.5 : 0.25;
  let ruler = '';
  for (
    let h = Math.ceil((view.from * 24) / tickHours) * tickHours;
    h <= view.to * 24;
    h += tickHours
  ) {
    const target = Math.round(((h / 24 - view.from) / (view.to - view.from)) * cells);
    if (ruler.length > target) continue;
    const label = Number.isInteger(h)
      ? String(h).padStart(2, '0')
      : clockFromFraction(h / 24).slice(0, 5);
    ruler += ' '.repeat(target - ruler.length) + label;
  }
  lines.push(`  ${' '.repeat(11)}${c.dim(ruler)}`);

  for (const day of [...stats.timeline].reverse()) {
    // The visible window in milliseconds from this day's midnight. Uses the day's
    // real length, which a DST transition makes 23 or 25 hours.
    const viewStart = view.from * day.dayMs;
    const viewEnd = view.to * day.dayMs;
    const cellMs = (viewEnd - viewStart) / cells;

    // Fraction of each cell that had at least one agent working, plus that cell's
    // peak level, so the row shows both when and how heavily.
    const filled = new Array<number>(cells).fill(0);
    const peak = new Array<number>(cells).fill(0);

    for (const interval of day.intervals) {
      const from = Math.max(viewStart, interval.start - day.midnight) - viewStart;
      const to = Math.min(viewEnd, interval.end - day.midnight) - viewStart;
      if (to <= from) continue;
      const firstCell = Math.floor(from / cellMs);
      const lastCell = Math.min(cells - 1, Math.floor((to - 1) / cellMs));
      for (let i = firstCell; i <= lastCell; i++) {
        const cellStart = i * cellMs;
        const overlap = Math.min(to, cellStart + cellMs) - Math.max(from, cellStart);
        if (overlap <= 0) continue;
        filled[i] = Math.min(1, (filled[i] ?? 0) + overlap / cellMs);
        peak[i] = Math.max(peak[i] ?? 0, interval.level);
      }
    }

    let row = '';
    for (let i = 0; i < cells; i++) {
      const fraction = filled[i] ?? 0;
      if (fraction <= 0) {
        row += c.idle('·');
        continue;
      }
      const index = Math.max(1, Math.min(ramp.length - 1, Math.ceil(fraction * (ramp.length - 1))));
      row += c.busy(ramp[index] ?? '█');
    }

    const date = new Date(day.midnight).toLocaleDateString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    });

    // With a window in view, the total has to be the visible total. Printing the
    // whole day's figure beside a three-hour slice reads as a contradiction.
    let visibleMs = day.activeMs;
    let visiblePeak = day.peak;
    if (view !== FULL_DAY) {
      visibleMs = 0;
      for (const lane of day.lanes) {
        for (const span of lane.spans) {
          const overlap =
            Math.min(span.end - day.midnight, viewEnd) -
            Math.max(span.start - day.midnight, viewStart);
          if (overlap > 0) visibleMs += overlap;
        }
      }
      visiblePeak = 0;
      for (const interval of day.intervals) {
        const overlap =
          Math.min(interval.end - day.midnight, viewEnd) -
          Math.max(interval.start - day.midnight, viewStart);
        if (overlap > 0 && interval.level > visiblePeak) visiblePeak = interval.level;
      }
    }

    lines.push(
      `  ${pad(date, 11)}${row} ${c.dim(padStart(duration(visibleMs), 8))} ${c.dim(`peak ${visiblePeak}`)}`,
    );
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
