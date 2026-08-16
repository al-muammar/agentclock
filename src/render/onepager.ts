import type { Anonymizer } from '../project.js';
import { duration, hours as decimalHours } from '../format.js';
import type { HourBucket, Stats, TimelineDay } from '../stats.js';
import { buildPdf, fitText, PdfPage, textWidth } from './pdf.js';

/**
 * The one-pager: the numbers worth sharing, plus the single most productive day
 * in the window, on one page.
 *
 * It is deliberately not a smaller dashboard. The HTML report is for looking
 * things up; this is for handing to someone who will read it once, so every
 * section has to earn its space and nothing scrolls or expands.
 */

/** A4. Narrower than Letter, so a page laid out for it also prints on Letter. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT = PAGE_WIDTH - MARGIN * 2;
const RIGHT = MARGIN + CONTENT;

// The report palette's light theme. A PDF has no theme to respond to, so only
// the light values exist here.
const INK = '#11171A';
const INK_2 = '#3B4750';
const MUTED = '#6A7681';
const LINE = '#D5DDE1';
const SURFACE = '#FFFFFF';
const PANEL = '#F4F8F8';
const BUSY = '#00786A';
const TRACK = '#E3E9EC';
/** Sequential ramp for concurrency: one hue, light to dark. */
const RAMP = ['#C4E4DD', '#84C8BC', '#3BA391', '#00786A'];

export interface OnePagerInput {
  stats: Stats;
  anon: Anonymizer;
  windowLabel: string;
  generatedAt: number;
}

/** Tracked uppercase, the same treatment the dashboard gives its field labels. */
function label(
  page: PdfPage,
  text: string,
  x: number,
  y: number,
  color = MUTED,
  size = 6.8,
  align: 'left' | 'right' = 'left',
): void {
  page.text(text.toUpperCase(), x, y, { size, color, tracking: 0.9, align });
}

/** Shrink a value until it fits its column. Numbers must never be clipped. */
function fittedSize(text: string, max: number, start: number, floor: number): number {
  let size = start;
  while (size > floor && textWidth(text, 'bold', size) > max) size -= 0.5;
  return size;
}

function longDate(midnight: number): string {
  return new Date(midnight).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function shortDay(midnight: number): string {
  return new Date(midnight).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function header(page: PdfPage, input: OnePagerInput): number {
  const { summary } = input.stats;
  page.text('Claude Code sessions', MARGIN, 66, { font: 'bold', size: 22, color: INK });

  label(page, input.windowLabel, RIGHT, 52, MUTED, 7.5, 'right');

  const range =
    summary.windowFrom > 0
      ? `${shortDay(summary.windowFrom)} – ${shortDay(summary.windowTo)}`
      : 'no activity recorded';
  page.text(range, RIGHT, 66, { size: 10, color: INK_2, align: 'right' });

  page.line(MARGIN, 80, RIGHT, 80, LINE, 1);
  return 80;
}

function heading(page: PdfPage, y: number, title: string, sub: string): number {
  page.text(title, MARGIN, y + 13, { font: 'bold', size: 11.5, color: INK });
  page.text(sub, MARGIN, y + 25, { size: 8, color: MUTED });
  return y + 34;
}

interface Tile {
  key: string;
  value: string;
  note: string;
  accent?: boolean;
}

function tiles(page: PdfPage, y: number, items: Tile[]): number {
  const gap = 9;
  const height = 64;
  const width = (CONTENT - gap * (items.length - 1)) / items.length;

  items.forEach((item, index) => {
    const x = MARGIN + index * (width + gap);
    page.box(x, y, width, height, { fill: SURFACE, stroke: LINE, radius: 4 });
    label(page, item.key, x + 11, y + 18);
    const size = fittedSize(item.value, width - 22, 18, 10);
    page.text(item.value, x + 11, y + 41, {
      font: 'bold',
      size,
      color: item.accent ? BUSY : INK,
    });
    page.text(fitText(item.note, 'regular', 7.2, width - 20), x + 11, y + 54, {
      size: 7.2,
      color: MUTED,
    });
  });

  return y + height;
}

/** The peak-agents ramp step for a level, matching the dashboard's four stops. */
function rampColor(level: number): string {
  return RAMP[Math.min(Math.max(1, level), RAMP.length) - 1] ?? RAMP[0]!;
}

/**
 * One day's activity across the clock: the union of what was running, then the
 * per-hour count of how many agents overlapped.
 */
function dayStrip(page: PdfPage, x: number, y: number, width: number, day: TimelineDay): number {
  const trackHeight = 11;
  page.box(x, y, width, trackHeight, { fill: TRACK, radius: 2 });

  for (const interval of day.intervals) {
    const from = Math.max(0, (interval.start - day.midnight) / day.dayMs);
    const to = Math.min(1, (interval.end - day.midnight) / day.dayMs);
    // A two-minute turn is a fraction of a point wide; floor it so short bursts
    // stay visible rather than vanishing on a 24-hour axis.
    const barWidth = Math.max(0.9, (to - from) * width);
    page.box(x + from * width, y, barWidth, trackHeight, {
      fill: rampColor(interval.level),
    });
  }

  const cellsY = y + trackHeight + 4;
  const cellHeight = 13;
  const cellWidth = width / 24;
  for (const bucket of day.hours) {
    const cellX = x + bucket.hour * cellWidth;
    const dim = bucket.peak === 0;
    page.box(cellX, cellsY, cellWidth - 1, cellHeight, {
      fill: dim ? TRACK : rampColor(bucket.peak),
      radius: 1.5,
    });
    page.text(dim ? '·' : String(bucket.peak), cellX + (cellWidth - 1) / 2, cellsY + 9.2, {
      size: 7,
      align: 'center',
      color: dim ? MUTED : bucket.peak >= 3 ? SURFACE : INK_2,
    });
  }

  const axisY = cellsY + cellHeight + 8;
  for (let hour = 0; hour <= 24; hour += 3) {
    page.text(String(hour).padStart(2, '0'), x + (hour / 24) * width, axisY, {
      size: 6.5,
      color: MUTED,
      align: hour === 0 ? 'left' : hour === 24 ? 'right' : 'center',
    });
  }

  return axisY;
}

/** Which projects a day's work went to, busiest first. */
function projectsOfDay(day: TimelineDay, anon: Anonymizer): Array<{ name: string; ms: number }> {
  const byProject = new Map<string, number>();
  for (const lane of day.lanes) {
    byProject.set(lane.project, (byProject.get(lane.project) ?? 0) + lane.activeMs);
  }
  return [...byProject.entries()]
    .map(([project, ms]) => ({ name: anon.projectLabel(project), ms }))
    .sort((a, b) => b.ms - a.ms);
}

function bestDayPanel(page: PdfPage, y: number, input: OnePagerInput): number {
  const { stats, anon } = input;
  const best = stats.timeline.reduce<TimelineDay | null>(
    // `>=` so the most recent day wins a tie: recency is the tiebreak a reader expects.
    (winner, day) => (winner === null || day.activeMs >= winner.activeMs ? day : winner),
    null,
  );
  if (!best || best.activeMs === 0) return y;

  const bucket = stats.days.find((d) => d.day === best.day);
  const share = stats.summary.activeMs > 0 ? (100 * best.activeMs) / stats.summary.activeMs : 0;
  const busiest = best.hours.reduce<HourBucket | null>(
    (winner, hour) =>
      hour.activeMs > 0 && (winner === null || hour.activeMs > winner.activeMs) ? hour : winner,
    null,
  );

  const height = 172;
  const pad = 16;
  const inner = CONTENT - pad * 2;
  const x = MARGIN + pad;
  page.box(MARGIN, y, CONTENT, height, { fill: PANEL, stroke: LINE, radius: 5 });

  label(page, 'Most productive day', x, y + 19, BUSY, 7.2);
  page.text(`${Math.round(share)}% of the period's agent work`, MARGIN + CONTENT - pad, y + 19, {
    size: 8,
    color: MUTED,
    align: 'right',
  });
  page.text(longDate(best.midnight), x, y + 42, { font: 'bold', size: 17, color: INK });

  const stats5: Array<[string, string]> = [
    ['Agent work', duration(best.activeMs)],
    ['Wall clock', duration(bucket?.coveredMs ?? 0)],
    ['Sessions', String(best.lanes.length)],
    ['Peak at once', String(best.peak)],
    ['Busiest hour', busiest ? `${String(busiest.hour).padStart(2, '0')}:00` : '—'],
  ];
  const column = inner / stats5.length;
  stats5.forEach(([key, value], index) => {
    const cx = x + index * column;
    page.text(value, cx, y + 68, {
      font: 'bold',
      size: fittedSize(value, column - 8, 13, 9),
      color: index === 0 ? BUSY : INK,
    });
    label(page, key, cx, y + 80);
  });

  const axisY = dayStrip(page, x, y + 90, inner, best);

  const projects = projectsOfDay(best, anon);
  if (projects.length > 0) {
    const shown = projects
      .slice(0, 3)
      .map((p) => `${p.name} ${duration(p.ms)}`)
      .join('  ·  ');
    const more = projects.length > 3 ? `  ·  +${projects.length - 3} more` : '';
    page.text(fitText(`${shown}${more}`, 'regular', 8, inner), x, axisY + 15, {
      size: 8,
      color: INK_2,
    });
  }

  return y + height;
}

/** Daily agent work, gaps included so a quiet week reads as a quiet week. */
function dailyChart(page: PdfPage, y: number, stats: Stats): number {
  if (stats.days.length === 0) return y;

  const byDay = new Map(stats.days.map((d) => [d.day, d]));
  const series: Array<{ at: number; value: number }> = [];
  const cursor = new Date(`${stats.days[0]!.day}T12:00:00`);
  const end = new Date(`${stats.days[stats.days.length - 1]!.day}T12:00:00`);
  while (cursor <= end && series.length < 400) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    series.push({ at: cursor.getTime(), value: byDay.get(key)?.activeMs ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const plotLeft = MARGIN + 26;
  const plotWidth = RIGHT - plotLeft;
  const plotHeight = 74;
  const top = y;
  const bottom = top + plotHeight;
  const max = Math.max(...series.map((d) => d.value), 1);

  page.line(plotLeft, top, RIGHT, top, '#E8EDEF', 0.75);
  page.text(`${decimalHours(max, 0)}h`, plotLeft - 6, top + 3, {
    size: 6.5,
    color: MUTED,
    align: 'right',
  });
  page.line(plotLeft, bottom, RIGHT, bottom, LINE, 0.75);
  page.text('0', plotLeft - 6, bottom + 3, { size: 6.5, color: MUTED, align: 'right' });

  const slot = plotWidth / series.length;
  const barWidth = Math.max(1.2, Math.min(24, slot - 1.6));
  series.forEach((day, index) => {
    const x = plotLeft + index * slot + (slot - barWidth) / 2;
    if (day.value === 0) {
      page.box(x, bottom - 1.2, barWidth, 1.2, { fill: TRACK });
      return;
    }
    const height = Math.max(1.6, (day.value / max) * plotHeight);
    page.box(x, bottom - height, barWidth, height, { fill: BUSY, radius: 1 });
  });

  // Roughly eight dates, plus the last column, so the axis stays readable.
  const step = Math.max(1, Math.ceil(series.length / 8));
  series.forEach((day, index) => {
    if (index % step !== 0 && index !== series.length - 1) return;
    page.text(shortDay(day.at), plotLeft + index * slot + slot / 2, bottom + 11, {
      size: 6.5,
      color: MUTED,
      align: 'center',
    });
  });

  return bottom + 14;
}

function projectBars(
  page: PdfPage,
  y: number,
  stats: Stats,
  anon: Anonymizer,
  rows: number,
): number {
  const worked = stats.projects.filter((p) => p.activeMs > 0);
  if (worked.length === 0) return y;

  // Whatever does not fit is summed into one row rather than dropped: a total
  // that silently excludes the tail is worse than a shorter list.
  const top: Array<{ project: string; activeMs: number; other?: boolean }> =
    worked.length > rows
      ? [
          ...worked.slice(0, rows - 1),
          {
            project: `${worked.length - rows + 1} others`,
            activeMs: worked.slice(rows - 1).reduce((sum, p) => sum + p.activeMs, 0),
            other: true,
          },
        ]
      : worked;

  const labelWidth = 116;
  const valueWidth = 62;
  const trackWidth = CONTENT - labelWidth - valueWidth;
  const rowHeight = 18;
  const barHeight = 10;
  const max = Math.max(...top.map((p) => p.activeMs), 1);

  top.forEach((project, index) => {
    const rowY = y + index * rowHeight;
    const name = project.other ? project.project : anon.projectLabel(project.project);
    page.text(
      fitText(name, 'regular', 8.5, labelWidth - 10),
      MARGIN + labelWidth - 10,
      rowY + 8.5,
      {
        size: 8.5,
        color: project.other ? MUTED : INK_2,
        align: 'right',
      },
    );
    page.box(MARGIN + labelWidth, rowY + (rowHeight - barHeight) / 2 - 2, trackWidth, barHeight, {
      fill: TRACK,
      radius: 2,
    });
    const width = Math.max(2, (project.activeMs / max) * trackWidth);
    page.box(MARGIN + labelWidth, rowY + (rowHeight - barHeight) / 2 - 2, width, barHeight, {
      fill: BUSY,
      radius: 2,
    });
    page.text(duration(project.activeMs), MARGIN + labelWidth + trackWidth + 8, rowY + 8.5, {
      size: 8.5,
      color: INK_2,
    });
  });

  return y + top.length * rowHeight;
}

function footer(page: PdfPage, input: OnePagerInput): void {
  const { stats } = input;
  const lines = [
    'Working time comes from Claude Code’s own per-turn duration records, not from sampling or estimation.',
    'A session with N subagents counts once. Historical waiting time is absent because a transcript cannot recover it.',
  ];
  if (stats.summary.sessionsWithoutTurnData > 0) {
    lines.push(
      `${stats.summary.sessionsWithoutTurnData} of these sessions predate Claude Code 2.1.222 and record no turn durations; they are counted, but contribute no working time.`,
    );
  }

  const y = PAGE_HEIGHT - MARGIN - lines.length * 10 - 12;
  page.line(MARGIN, y, RIGHT, y, LINE, 0.75);
  lines.forEach((line, index) => {
    page.text(fitText(line, 'regular', 7.2, CONTENT), MARGIN, y + 14 + index * 10, {
      size: 7.2,
      color: MUTED,
    });
  });
  page.text(
    `agentclock · generated ${new Date(input.generatedAt).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`,
    RIGHT,
    y - 6,
    { size: 7.2, color: MUTED, align: 'right' },
  );
}

function document(page: PdfPage, input: OnePagerInput): Buffer {
  return buildPdf([page], {
    title: 'Claude Code sessions',
    subject: input.windowLabel,
    createdAt: input.generatedAt,
  });
}

export function renderOnePager(input: OnePagerInput): Buffer {
  const { stats, anon } = input;
  const { summary } = stats;
  const page = new PdfPage(PAGE_WIDTH, PAGE_HEIGHT);

  let y = header(page, input) + 22;

  const activeProjects = stats.projects.filter((p) => p.activeMs > 0).length;
  y = tiles(page, y, [
    {
      key: 'Sessions',
      value: String(summary.sessions),
      note: `in ${activeProjects} active project${activeProjects === 1 ? '' : 's'}`,
    },
    {
      key: 'Agent work',
      value: duration(summary.activeMs),
      note: `${summary.turns} completed turns`,
      accent: true,
    },
    {
      key: 'Wall clock',
      // WinAnsi has no ≥, and the transliteration ">=1" reads worse than words.
      value: duration(summary.coveredMs),
      note: 'with an agent working',
    },
    {
      key: 'Parallelism',
      value: `${summary.parallelism.toFixed(2)}×`,
      note: 'work per hour elapsed',
    },
    {
      key: 'Peak',
      value: String(summary.peakConcurrency),
      note: 'most agents at once',
    },
  ]);

  // Nothing to chart is a real answer, and it has to say which of the two it is:
  // no sessions at all, or sessions that record no working time.
  if (summary.activeMs === 0) {
    page.text(
      summary.sessions === 0
        ? 'No sessions in this window.'
        : 'These sessions record no working time, so there is nothing to chart.',
      MARGIN,
      y + 44,
      { size: 11, color: MUTED },
    );
    footer(page, input);
    return document(page, input);
  }

  const afterPanel = bestDayPanel(page, y + 22, input);
  y = afterPanel > y + 22 ? afterPanel : y;

  if (stats.days.length > 0) {
    y = heading(
      page,
      y + 24,
      'Agent work per day',
      'Summed across sessions, so a day with two agents running in parallel can exceed 24 hours',
    );
    y = dailyChart(page, y, stats);
  }

  if (stats.projects.some((p) => p.activeMs > 0)) {
    y = heading(
      page,
      y + 18,
      'Where the time went',
      'Agent working time by project · git worktrees folded into their repository',
    );
    // Whatever vertical space is left decides how many projects fit: the page
    // must not spill onto a second sheet.
    const available = PAGE_HEIGHT - MARGIN - 56 - y;
    y = projectBars(page, y, stats, anon, Math.max(1, Math.min(9, Math.floor(available / 18))));
  }

  footer(page, input);

  return document(page, input);
}
