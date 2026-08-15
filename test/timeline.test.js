import { test } from 'node:test';
import assert from 'node:assert/strict';

const { concurrencyProfile, computeStats, buildTimeline, midnightOf, dayKey } = await import(
  '../dist/stats.js'
);
const { timelineTrack, MAX_RAMP_LEVEL } = await import('../dist/render/svg.js');
const { renderReport } = await import('../dist/render/html.js');
const { Anonymizer } = await import('../dist/project.js');
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

test('timelineTrack positions bars by fraction of the day', () => {
  const html = timelineTrack([{ from: 0.5, to: 0.75, level: 1, title: 'noon to six' }], 'a day');
  assert.match(html, /left:50\.00%/);
  assert.match(html, /width:25\.00%/);
  assert.match(html, /title="noon to six"/);
  assert.match(html, /class="b lv1"/);
  assert.match(html, /aria-label="a day"/);
});

test('timelineTrack clamps the ramp at its top step', () => {
  const html = timelineTrack([
    { from: 0, to: 0.1, level: 1, title: 'a' },
    { from: 0.2, to: 0.3, level: 99, title: 'b' },
  ]);
  assert.match(html, /class="b lv1"/);
  assert.match(html, new RegExp(`class="b lv${MAX_RAMP_LEVEL}"`), 'high levels reuse the top step');
  assert.ok(!html.includes('lv99'));
});

test('timelineTrack clamps positions into the day', () => {
  // A span clipped at a boundary can round marginally outside; it must not
  // overhang the track.
  const html = timelineTrack([{ from: -0.2, to: 1.4, level: 1, title: 'all day' }]);
  assert.match(html, /left:0\.00%/);
  assert.match(html, /width:100\.00%/);
});

test('timelineTrack escapes titles', () => {
  const html = timelineTrack([{ from: 0, to: 1, level: 1, title: '"><script>alert(1)</script>' }]);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('timelineTrack renders an empty track when there is nothing to show', () => {
  const html = timelineTrack([]);
  assert.match(html, /class="tl-track"/);
  assert.ok(!html.includes('class="b '));
});

// ---------- lanes: clicking a day opens its sessions ----------

const laneReport = (records, anonymize = false) =>
  renderReport({
    stats: computeStats(records),
    live: [],
    anon: new Anonymizer(anonymize),
    windowLabel: 'Last 30d',
    generatedAt: Date.now(),
  });

test('each day carries a lane per session that worked that day', () => {
  const start = day(2026, 8, 12, 9);
  const stats = computeStats([
    session('a', '/repo/alpha', [{ start, end: start + 2 * HOUR }]),
    session('b', '/repo/beta', [{ start: start + HOUR, end: start + 90 * MIN }]),
  ]);

  const entry = stats.timeline.find((t) => t.day === dayKey(start));
  assert.equal(entry.lanes.length, 2);
  // Busiest first, so opening a day leads with what dominated it.
  assert.equal(entry.lanes[0].sessionId, 'a');
  assert.equal(entry.lanes[0].activeMs, 2 * HOUR);
  assert.equal(entry.lanes[1].activeMs, 30 * MIN);
});

test('a session working on two days gets a lane on each, with only that day’s time', () => {
  const start = day(2026, 8, 15, 23, 30);
  const end = day(2026, 8, 16, 0, 30);
  const stats = computeStats([session('x', '/r', [{ start, end }])]);

  const first = stats.timeline.find((t) => t.day === '2026-08-15');
  const second = stats.timeline.find((t) => t.day === '2026-08-16');
  assert.equal(first.lanes.length, 1);
  assert.equal(second.lanes.length, 1);
  assert.equal(first.lanes[0].activeMs, 30 * MIN);
  assert.equal(second.lanes[0].activeMs, 30 * MIN);
  assert.equal(first.lanes[0].sessionId, second.lanes[0].sessionId);
});

test('lane time never exceeds its day', () => {
  const start = day(2026, 8, 12, 0);
  const stats = computeStats([session('a', '/r', [{ start, end: start + 20 * HOUR }])]);
  const entry = stats.timeline.find((t) => t.day === dayKey(start));
  for (const lane of entry.lanes) {
    assert.ok(lane.activeMs <= entry.dayMs, 'a lane cannot be longer than the day');
    for (const span of lane.spans) {
      assert.ok(span.start >= entry.midnight);
      assert.ok(span.end <= entry.midnight + entry.dayMs);
    }
  }
});

test('dayMs is the real length of the local day', () => {
  const start = day(2026, 8, 12, 9);
  const stats = computeStats([session('a', '/r', [{ start, end: start + HOUR }])]);
  const entry = stats.timeline[0];
  // 24h normally; a DST transition makes it 23 or 25, never anything else.
  assert.ok([23, 24, 25].includes(entry.dayMs / HOUR), `unexpected day length ${entry.dayMs}`);
});

test('the report makes each day an expandable details element', () => {
  const start = day(2026, 8, 12, 9);
  const html = laneReport([
    session('alpha-session', '/repo/alpha', [{ start, end: start + HOUR }]),
    session('beta-session', '/repo/beta', [{ start: start + 30 * MIN, end: start + 90 * MIN }]),
  ]);

  assert.match(html, /<details class="tl-day"/);
  assert.match(html, /<summary>/);
  assert.match(html, /click a day to see the individual sessions/);
  // Both sessions appear as lanes inside the day.
  assert.match(html, /alpha-session/);
  assert.match(html, /beta-session/);
  assert.match(html, /2 sessions worked this day/);
});

test('the most recent day is open so the drill-down is discoverable', () => {
  const start = day(2026, 8, 12, 9);
  const html = laneReport([session('a', '/r', [{ start, end: start + HOUR }])]);
  assert.match(html, /<details class="tl-day" open>/);
  assert.equal((html.match(/<details class="tl-day" open>/g) ?? []).length, 1);
});

test('lane names respect --anonymize', () => {
  const start = day(2026, 8, 12, 9);
  const records = [session('acme-work', '/Users/me/clients/acme', [{ start, end: start + HOUR }])];
  assert.ok(laneReport(records).includes('acme-work'));

  const hidden = laneReport(records, true);
  assert.ok(!hidden.includes('acme-work'), 'session label must not survive anonymisation');
  assert.ok(!hidden.includes('acme'));
});

test('the timeline markup is balanced', () => {
  const start = day(2026, 8, 12, 9);
  const html = laneReport([
    session('a', '/r/a', [{ start, end: start + HOUR }]),
    session('b', '/r/b', [{ start: start + 10 * MIN, end: start + 40 * MIN }]),
  ]);
  for (const tag of ['details', 'summary', 'i', 'span', 'div', 'p']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `unbalanced <${tag}>`);
  }
});

test('the timeline stays script-free', () => {
  const start = day(2026, 8, 12, 9);
  const html = laneReport([session('a', '/r', [{ start, end: start + HOUR }])]);
  // The drill-down uses <details>, not JavaScript.
  assert.ok(!/<script/i.test(html));
  assert.ok(!/onclick/i.test(html));
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
