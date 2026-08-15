import { test } from 'node:test';
import assert from 'node:assert/strict';

const { concurrencyProfile, computeStats, buildTimeline, midnightOf, dayKey } = await import(
  '../dist/stats.js'
);
const { timelineChart } = await import('../dist/render/svg.js');
const { renderTimeline } = await import('../dist/render/term.js');

const MIN = 60_000;
const HOUR = 3_600_000;

const session = (id, project, spans) => ({
  sessionId: id,
  cwd: project,
  project,
  label: id,
  startedAt: Math.min(...spans.map((s) => s.start)),
  endedAt: Math.max(...spans.map((s) => s.end)),
  turns: spans.length,
  activeMs: spans.reduce((sum, s) => sum + (s.end - s.start), 0),
  hasTurnData: true,
  prompts: 1,
  spans,
  file: `/t/${id}.jsonl`,
  mtimeMs: 1,
  size: 1,
});

/** Local 09:00 on a fixed day, so the tests do not depend on the runner's zone. */
const day = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

// ---------- intervals ----------

test('intervals report the level and which projects were working', () => {
  const start = day(2026, 8, 10, 9);
  const { intervals } = concurrencyProfile([
    session('a', '/repo/alpha', [{ start, end: start + 2 * HOUR }]),
    session('b', '/repo/beta', [{ start: start + HOUR, end: start + 3 * HOUR }]),
  ]);

  assert.equal(intervals.length, 3);
  assert.deepEqual(
    intervals.map((i) => i.level),
    [1, 2, 1],
  );
  assert.deepEqual(intervals[0].projects, ['/repo/alpha']);
  assert.deepEqual(intervals[1].projects.sort(), ['/repo/alpha', '/repo/beta']);
  assert.deepEqual(intervals[2].projects, ['/repo/beta']);
});

test('every interval level equals its project count', () => {
  const start = day(2026, 8, 10, 8);
  const { intervals } = concurrencyProfile([
    session('a', '/r/a', [{ start, end: start + 3 * HOUR }]),
    session('b', '/r/b', [{ start: start + HOUR, end: start + 2 * HOUR }]),
    session('c', '/r/c', [{ start: start + 90 * MIN, end: start + 4 * HOUR }]),
  ]);
  for (const interval of intervals) {
    assert.equal(interval.level, interval.projects.length, 'level must match the active set');
  }
});

test('two sessions in the same project still count as two', () => {
  // Level counts sessions; the project list is deduplicated for display only.
  const start = day(2026, 8, 10, 10);
  const { intervals, peak } = concurrencyProfile([
    session('a', '/repo/same', [{ start, end: start + HOUR }]),
    session('b', '/repo/same', [{ start, end: start + HOUR }]),
  ]);
  assert.equal(peak, 2);
  assert.equal(intervals[0].level, 2);
  assert.deepEqual(intervals[0].projects, ['/repo/same']);
});

test('one session with many merged spans never exceeds level 1', () => {
  const start = day(2026, 8, 10, 9);
  const { intervals, peak } = concurrencyProfile([
    session('solo', '/r', [
      { start, end: start + HOUR },
      { start: start + 2 * HOUR, end: start + 3 * HOUR },
    ]),
  ]);
  assert.equal(peak, 1);
  assert.ok(intervals.every((i) => i.level === 1));
});

test('adjacent stretches at the same level are merged into one interval', () => {
  // b ends exactly when c starts, so the level never changes: one rect, not two.
  const start = day(2026, 8, 10, 9);
  const { intervals } = concurrencyProfile([
    session('b', '/r/b', [{ start, end: start + HOUR }]),
    session('c', '/r/c', [{ start: start + HOUR, end: start + 2 * HOUR }]),
  ]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].end - intervals[0].start, 2 * HOUR);
});

// ---------- day splitting ----------

test('midnightOf returns local midnight for a day key', () => {
  const midnight = midnightOf('2026-08-15');
  const d = new Date(midnight);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(dayKey(midnight), '2026-08-15');
});

test('an interval crossing midnight is split across both days', () => {
  const start = day(2026, 8, 15, 23, 30);
  const end = day(2026, 8, 16, 0, 30);
  const stats = computeStats([session('x', '/r', [{ start, end }])]);

  const byDay = Object.fromEntries(stats.timeline.map((t) => [t.day, t]));
  assert.ok(byDay['2026-08-15'], 'first day present');
  assert.ok(byDay['2026-08-16'], 'second day present');

  for (const [key, entry] of Object.entries(byDay)) {
    for (const interval of entry.intervals) {
      assert.ok(interval.start >= entry.midnight, `${key}: interval starts on its own day`);
      assert.ok(
        interval.end <= entry.midnight + 24 * HOUR,
        `${key}: interval ends within its own day`,
      );
    }
  }
});

test('timeline interval time sums to the day total', () => {
  const start = day(2026, 8, 12, 10);
  const stats = computeStats([
    session('a', '/r/a', [{ start, end: start + HOUR }]),
    session('b', '/r/b', [{ start: start + 30 * MIN, end: start + 90 * MIN }]),
  ]);

  const dayEntry = stats.timeline.find((t) => t.day === dayKey(start));
  const covered = dayEntry.intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  // Intervals are the union of working time; activeMs sums each session separately.
  assert.equal(covered, 90 * MIN);
  assert.equal(dayEntry.activeMs, 2 * HOUR);
  assert.equal(dayEntry.peak, 2);
});

test('buildTimeline only emits days that had activity', () => {
  const start = day(2026, 8, 12, 10);
  const stats = computeStats([session('a', '/r/a', [{ start, end: start + HOUR }])]);
  assert.equal(stats.timeline.length, 1);
  assert.equal(stats.timeline[0].day, dayKey(start));
});

test('buildTimeline copes with no intervals at all', () => {
  assert.deepEqual(buildTimeline([], []), []);
  assert.deepEqual(computeStats([]).timeline, []);
});

// ---------- rendering ----------

test('timelineChart positions bars by fraction of the day', () => {
  const svg = timelineChart([
    {
      label: 'Sat 15 Aug',
      total: '1h',
      bars: [{ from: 0.5, to: 0.75, level: 1, title: 'noon to six' }],
    },
  ]);
  assert.match(svg, /role="img"/);
  assert.match(svg, /<title>noon to six<\/title>/);
  assert.match(svg, /class="lv1"/);
});

test('timelineChart clamps the ramp at its top step', () => {
  const svg = timelineChart([
    {
      label: 'day',
      total: '1h',
      bars: [
        { from: 0, to: 0.1, level: 1, title: 'a' },
        { from: 0.2, to: 0.3, level: 9, title: 'b' },
      ],
    },
  ]);
  assert.match(svg, /class="lv1"/);
  assert.match(svg, /class="lv4"/, 'level 9 uses the top ramp step');
  assert.ok(!svg.includes('class="lv9"'));
});

test('timelineChart keeps a brief burst visible', () => {
  const svg = timelineChart([
    { label: 'day', total: '2m', bars: [{ from: 0.5, to: 0.5008, level: 1, title: 'burst' }] },
  ]);
  const widths = [...svg.matchAll(/class="lv1"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths[0] >= 1.5, 'a two-minute burst must not vanish on a 24h axis');
});

test('timelineChart escapes labels and titles', () => {
  const svg = timelineChart([
    { label: '<b>day</b>', total: '&', bars: [{ from: 0, to: 1, level: 1, title: '<script>' }] },
  ]);
  assert.ok(!svg.includes('<b>day</b>'));
  assert.ok(!svg.includes('<title><script></title>'));
});

test('timelineChart returns empty string with no rows', () => {
  assert.equal(timelineChart([]), '');
});

test('the terminal timeline marks active cells and leaves the rest blank', () => {
  process.env.NO_COLOR = '1';
  const start = day(2026, 8, 12, 12);
  const stats = computeStats([session('a', '/r/a', [{ start, end: start + HOUR }])]);
  const out = renderTimeline(stats, 24); // one cell per hour

  const row = out.split('\n').find((l) => l.includes('Aug'));
  assert.ok(row, 'a day row is rendered');
  // Midnight through 11:00 is idle, hour 12 is active.
  assert.ok(row.includes('·'), 'idle cells use the dot');
  assert.match(row, /[▁▃▅▇█]/, 'the active hour uses a block character');
  delete process.env.NO_COLOR;
});

test('the terminal timeline says so when there is nothing to show', () => {
  const out = renderTimeline(computeStats([]), 24);
  assert.match(out, /No agent activity/i);
});
