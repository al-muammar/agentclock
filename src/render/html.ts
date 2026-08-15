import { Anonymizer } from '../project.js';
import { dateTime, duration, hours, shortDate, truncate } from '../format.js';
import { esc, hBarChart, vBarChart, type BarItem, type VBarItem } from './svg.js';
import { ACTIVE_STATUSES, type LiveSession } from '../types.js';
import type { Stats } from '../stats.js';

/**
 * Palette. Both themes were checked with a CVD validator: the busy/waiting pair
 * separates at ΔE 10.4 (light) and 11.3 (dark) under protanopia, comfortably above
 * the ΔE 8 floor. Idle is deliberately near-neutral — "nothing is happening" should
 * read as grey rather than compete for attention.
 */
const STYLE = `
  :root {
    /* Declare that the page handles both themes itself. Without this, Chrome's
       auto-darkening runs on top of the media query and re-inverts SVG fills, so
       chart tracks come out white on a dark page. */
    color-scheme: light dark;

    --ground: #F2F5F6;
    --surface: #FFFFFF;
    --surface-2: #E8EDEF;
    --ink: #11171A;
    --ink-2: #3B4750;
    --muted: #6A7681;
    --line: #D5DDE1;
    --line-soft: #E3E9EC;
    --busy: #00786A;
    --waiting: #B4560F;
    --idle: #7C8794;
    --track: #E3E9EC;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0D1114;
      --surface: #161B21;
      --surface-2: #1D242B;
      --ink: #E6ECEF;
      --ink-2: #B2BEC7;
      --muted: #89959F;
      --line: #273038;
      --line-soft: #1F272E;
      --busy: #26A18E;
      --waiting: #D07E33;
      --idle: #6D7986;
      --track: #222A31;
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 0 24px 96px;
    background: var(--ground);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: 980px; margin: 0 auto; }

  header.top {
    padding: 56px 0 28px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    gap: 12px 32px;
    align-items: baseline;
    justify-content: space-between;
  }
  h1 {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 30px;
    letter-spacing: -.02em;
    font-weight: 600;
    margin: 0;
  }
  .meta {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  section { padding: 34px 0; border-bottom: 1px solid var(--line-soft); }
  section:last-of-type { border-bottom: none; }

  h2 {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -.01em;
    margin: 0 0 3px;
  }
  .sub {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--muted);
    margin: 0 0 20px;
  }

  .tiles {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 16px 18px;
  }
  .tile .k {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    display: block;
    margin-bottom: 8px;
  }
  .tile .v {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 27px;
    font-weight: 600;
    letter-spacing: -.02em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .tile .n { font-size: 12px; color: var(--muted); margin-top: 7px; }
  .v.busy { color: var(--busy); }

  figure {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 20px;
    overflow-x: auto;
  }
  svg.chart { width: 100%; height: auto; display: block; overflow: visible; }

  .bar-busy { fill: var(--busy); }
  .track { fill: var(--track); }
  .axis { stroke: var(--line); stroke-width: 1; }
  .grid { stroke: var(--line-soft); stroke-width: 1; }
  .row-label,
  .row-value,
  .tick {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-variant-numeric: tabular-nums;
  }
  .row-label { fill: var(--ink-2); font-size: 11.5px; }
  .row-value { fill: var(--ink-2); font-size: 11.5px; }
  .tick { fill: var(--muted); font-size: 10.5px; }

  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 14px; }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .dot { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .dot.busy { background: var(--busy); }
  .dot.waiting { background: var(--waiting); }
  .dot.idle { background: var(--idle); }

  .live { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px 6px 11px;
    font-size: 13px;
  }
  .chip b { font-variant-numeric: tabular-nums; }

  .tablewrap {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
  }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line-soft); }
  thead th {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
    white-space: nowrap;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
  }
  tbody tr:last-child td { border-bottom: none; }
  td.num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  td.name { font-weight: 500; }
  td.dim { color: var(--muted); }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
  }
  .state.busy { color: var(--busy); }
  .state.waiting { color: var(--waiting); }
  .state.idle { color: var(--idle); }

  .note {
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 3px solid var(--waiting);
    border-radius: 4px;
    padding: 14px 18px;
    color: var(--ink-2);
    font-size: 13.5px;
  }
  .note + .note { margin-top: 10px; }

  footer {
    padding: 32px 0 0;
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    line-height: 1.7;
  }
  footer a { color: var(--busy); }
`;

export interface ReportInput {
  stats: Stats;
  live: LiveSession[];
  anon: Anonymizer;
  windowLabel: string;
  generatedAt: number;
}

function tile(label: string, value: string, note: string, accent = false): string {
  return `      <div class="tile">
        <span class="k">${esc(label)}</span>
        <div class="v${accent ? ' busy' : ''}">${esc(value)}</div>
        <div class="n">${esc(note)}</div>
      </div>`;
}

function liveSection(live: LiveSession[], anon: Anonymizer): string {
  if (live.length === 0) return '';

  const active = live.filter((s) => ACTIVE_STATUSES.has(s.status));
  const waiting = live.filter((s) => s.status === 'waiting');
  const idle = live.filter((s) => s.status === 'idle');
  const other = live.filter(
    (s) => !ACTIVE_STATUSES.has(s.status) && s.status !== 'waiting' && s.status !== 'idle',
  );

  const rows = [...live]
    .sort((a, b) => {
      const rank = (s: LiveSession) =>
        ACTIVE_STATUSES.has(s.status) ? 0 : s.status === 'waiting' ? 1 : 2;
      return rank(a) - rank(b) || a.startedAt - b.startedAt;
    })
    .map((s) => {
      const cls = ACTIVE_STATUSES.has(s.status)
        ? 'busy'
        : s.status === 'waiting'
          ? 'waiting'
          : 'idle';
      const label = anon.session(s.name ?? s.sessionId.slice(0, 8), s.sessionId);
      const project = anon.projectLabel(s.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, ''));
      const state = s.waitingFor ? `${s.status} · ${s.waitingFor}` : s.status;
      return `          <tr>
            <td class="name">${esc(label)}</td>
            <td class="dim">${esc(project)}</td>
            <td><span class="state ${cls}">● ${esc(state)}</span></td>
            <td class="num">${esc(duration(Date.now() - s.startedAt))}</td>
          </tr>`;
    })
    .join('\n');

  const chips = [
    `<span class="chip"><span class="dot busy"></span><b>${active.length}</b> working</span>`,
    `<span class="chip"><span class="dot waiting"></span><b>${waiting.length}</b> waiting on you</span>`,
    `<span class="chip"><span class="dot idle"></span><b>${idle.length}</b> idle</span>`,
  ];
  if (other.length > 0) {
    chips.push(`<span class="chip"><b>${other.length}</b> unknown state</span>`);
  }

  return `  <section>
    <h2>Right now</h2>
    <p class="sub">${live.length} session${live.length === 1 ? '' : 's'} open · one row per session, subagents included</p>
    <div class="live">${chips.join('\n      ')}</div>
    <div class="tablewrap" style="margin-top:16px">
      <table>
        <thead><tr><th>Session</th><th>Project</th><th>State</th><th style="text-align:right">Uptime</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

function concurrencySection(stats: Stats): string {
  if (stats.concurrency.length === 0) return '';

  const items: BarItem[] = stats.concurrency.map((b) => ({
    label: `${b.level} busy`,
    value: b.ms,
    display: duration(b.ms),
    title: `${b.level} session${b.level === 1 ? '' : 's'} working simultaneously for ${duration(b.ms)}`,
  }));

  return `  <section>
    <h2>How often you run agents in parallel</h2>
    <p class="sub">Wall-clock time at each level of simultaneous agent work</p>
    <figure>${hBarChart(items, { labelWidth: 78, valueWidth: 84, axisFormat: (v) => duration(v) })}</figure>
  </section>`;
}

function dailySection(stats: Stats): string {
  if (stats.days.length === 0) return '';

  // Fill missing days so gaps read as gaps rather than being silently compressed.
  const first = stats.days[0]!.day;
  const last = stats.days[stats.days.length - 1]!.day;
  const byDay = new Map(stats.days.map((d) => [d.day, d]));
  const filled: VBarItem[] = [];

  const cursor = new Date(`${first}T12:00:00`);
  const end = new Date(`${last}T12:00:00`);
  while (cursor <= end && filled.length < 400) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const bucket = byDay.get(key);
    const value = bucket?.activeMs ?? 0;
    filled.push({
      label: shortDate(cursor.getTime()),
      value,
      display: duration(value),
      title: bucket
        ? `${key} — ${duration(value)} of agent work across ${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'}, peak ${bucket.peak} at once`
        : `${key} — no agent activity`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  // Label roughly ten columns, plus the last one, so the axis stays readable.
  const step = Math.max(1, Math.ceil(filled.length / 10));
  filled.forEach((item, i) => {
    item.showLabel = i % step === 0 || i === filled.length - 1;
  });

  return `  <section>
    <h2>Agent work per day</h2>
    <p class="sub">Summed across sessions, so a day with two agents running in parallel can exceed 24 hours</p>
    <figure>${vBarChart(filled, { maxFormat: (v) => `${hours(v, 0)}h` })}</figure>
  </section>`;
}

function projectSection(stats: Stats, anon: Anonymizer): string {
  if (stats.projects.length === 0) return '';

  const top = stats.projects.slice(0, 12);
  const rest = stats.projects.slice(12);
  const items: BarItem[] = top.map((p) => ({
    label: truncate(anon.projectLabel(p.project), 22),
    value: p.activeMs,
    display: duration(p.activeMs),
    title: `${anon.projectLabel(p.project)}: ${duration(p.activeMs)} across ${p.sessions} session${p.sessions === 1 ? '' : 's'}`,
  }));

  if (rest.length > 0) {
    const otherMs = rest.reduce((sum, p) => sum + p.activeMs, 0);
    if (otherMs > 0) {
      items.push({
        label: `${rest.length} others`,
        value: otherMs,
        display: duration(otherMs),
        title: `${rest.length} further projects totalling ${duration(otherMs)}`,
      });
    }
  }

  return `  <section>
    <h2>Where the time went</h2>
    <p class="sub">Agent working time by project · git worktrees folded into their repository</p>
    <figure>${hBarChart(items, { labelWidth: 168, valueWidth: 84, axisFormat: (v) => duration(v) })}</figure>
  </section>`;
}

function sessionSection(stats: Stats, anon: Anonymizer): string {
  const withWork = stats.sessions.filter((s) => s.activeMs > 0).slice(0, 40);
  if (withWork.length === 0) return '';

  const rows = withWork
    .map((s) => {
      const lifetime = s.endedAt - s.startedAt;
      const ratio = lifetime > 0 ? (100 * s.activeMs) / lifetime : 0;
      return `          <tr>
            <td class="name">${esc(truncate(anon.session(s.label, s.sessionId), 34))}</td>
            <td class="dim">${esc(truncate(anon.projectLabel(s.project), 24))}</td>
            <td class="num">${esc(duration(s.activeMs))}</td>
            <td class="num">${esc(duration(lifetime))}</td>
            <td class="num">${ratio < 1 ? '&lt;1' : Math.round(ratio)}%</td>
            <td class="num">${s.turns}</td>
            <td class="num dim">${esc(shortDate(s.endedAt))}</td>
          </tr>`;
    })
    .join('\n');

  const hidden = stats.sessions.filter((s) => s.activeMs > 0).length - withWork.length;

  return `  <section>
    <h2>Sessions</h2>
    <p class="sub">Ranked by agent working time${hidden > 0 ? ` · showing 40 of ${withWork.length + hidden}` : ''}</p>
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Session</th><th>Project</th>
            <th style="text-align:right">Working</th>
            <th style="text-align:right">Lifetime</th>
            <th style="text-align:right">Busy</th>
            <th style="text-align:right">Turns</th>
            <th style="text-align:right">Last active</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

export function renderReport(input: ReportInput): string {
  const { stats, live, anon, windowLabel, generatedAt } = input;
  const { summary } = stats;

  const tiles = [
    // Count only projects that actually accrued working time — most sessions in a
    // long window are one-prompt shells in their own directory, and counting those
    // makes the project figure look impressive while meaning nothing.
    tile(
      'Sessions',
      String(summary.sessions),
      `in ${stats.projects.filter((p) => p.activeMs > 0).length} active project${
        stats.projects.filter((p) => p.activeMs > 0).length === 1 ? '' : 's'
      }`,
    ),
    tile('Agent work', duration(summary.activeMs), `${summary.turns} completed turns`, true),
    tile('Wall clock', duration(summary.coveredMs), 'time with ≥1 agent working'),
    tile('Parallelism', `${summary.parallelism.toFixed(2)}×`, 'work done per hour elapsed'),
    tile('Peak', String(summary.peakConcurrency), 'most agents at once'),
  ].join('\n');

  const notes: string[] = [];
  if (summary.sessionsWithoutTurnData > 0) {
    notes.push(
      `<div class="note"><strong>${summary.sessionsWithoutTurnData}</strong> of these sessions predate Claude Code 2.1.222, which introduced the per-turn duration record. They are counted as sessions but contribute no working time — an absent number rather than an estimated one.</div>`,
    );
  }
  notes.push(
    `<div class="note">Historical <strong>waiting</strong> time is not shown because it cannot be recovered: nothing in a transcript distinguishes a permission prompt from a coffee break. Waiting appears in <strong>Right now</strong> only.</div>`,
  );

  const body = [
    liveSection(live, anon),
    `  <section>
    <h2>${esc(windowLabel)}</h2>
    <p class="sub">${summary.windowFrom > 0 ? `${esc(shortDate(summary.windowFrom))} – ${esc(shortDate(summary.windowTo))}` : 'no activity recorded'}</p>
    <div class="tiles">
${tiles}
    </div>
  </section>`,
    concurrencySection(stats),
    dailySection(stats),
    projectSection(stats, anon),
    sessionSection(stats, anon),
    `  <section>
    <h2>Reading these numbers</h2>
    <p class="sub">What is measured, and what is deliberately absent</p>
${notes.join('\n')}
  </section>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cctrack — Claude Code session report</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Claude Code sessions</h1>
    <div class="meta">${esc(dateTime(generatedAt))}</div>
  </header>
${body}
  <footer>
    Generated by cctrack from ~/.claude · a session with N subagents counts once.<br>
    Working time comes from Claude Code's own per-turn duration records, not from sampling or estimation.<br>
    Claude Code deletes transcripts after 30 days, so this report covers only what remains on disk.
  </footer>
</div>
</body>
</html>
`;
}
