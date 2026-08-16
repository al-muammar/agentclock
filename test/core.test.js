import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSpans, totalMs, clip } from '../dist/spans.js';
import { attribute, Anonymizer } from '../dist/project.js';
import { parseEtime } from '../dist/registry.js';
import { parseWindow, duration } from '../dist/format.js';
import { concurrencyProfile, computeStats, dayKey } from '../dist/stats.js';

const span = (start, end) => ({ start, end });

test('mergeSpans collapses overlapping spans', () => {
  const merged = mergeSpans([span(0, 10), span(5, 20), span(30, 40)]);
  assert.deepEqual(merged, [span(0, 20), span(30, 40)]);
});

test('mergeSpans collapses touching spans', () => {
  assert.deepEqual(mergeSpans([span(0, 10), span(10, 20)]), [span(0, 20)]);
});

test('mergeSpans drops zero-length and inverted spans', () => {
  assert.deepEqual(mergeSpans([span(5, 5), span(10, 3)]), []);
});

test('mergeSpans handles a span fully contained in another', () => {
  assert.deepEqual(mergeSpans([span(0, 100), span(20, 30)]), [span(0, 100)]);
});

test('totalMs sums merged spans', () => {
  assert.equal(totalMs([span(0, 10), span(20, 25)]), 15);
});

test('clip restricts to a window and drops what falls outside', () => {
  assert.deepEqual(clip([span(0, 10), span(50, 60)], 5, 55), [span(5, 10), span(50, 55)]);
  assert.deepEqual(clip([span(0, 10)], 20, 30), []);
});

test('a session with many overlapping turns never counts more than once', () => {
  // This is the "N subagents = 1 session" guarantee, expressed in the data model.
  const session = {
    sessionId: 's1',
    cwd: '/repo',
    project: '/repo',
    label: 'repo',
    startedAt: 0,
    endedAt: 100,
    turns: 3,
    activeMs: 0,
    hasTurnData: true,
    prompts: 1,
    spans: mergeSpans([span(0, 60), span(10, 70), span(20, 80)]),
    file: 'a.jsonl',
    mtimeMs: 0,
    size: 0,
  };
  const { peak } = concurrencyProfile([session]);
  assert.equal(peak, 1, 'one session must never exceed concurrency 1');
});

test('concurrencyProfile measures simultaneous sessions', () => {
  const mk = (id, spans) => ({
    sessionId: id,
    cwd: '/r',
    project: '/r',
    label: 'r',
    startedAt: 0,
    endedAt: 100,
    turns: spans.length,
    activeMs: totalMs(spans),
    hasTurnData: true,
    prompts: 0,
    spans,
    file: `${id}.jsonl`,
    mtimeMs: 0,
    size: 0,
  });

  const profile = concurrencyProfile([
    mk('a', [span(0, 100)]),
    mk('b', [span(50, 150)]),
    mk('c', [span(60, 70)]),
  ]);

  assert.equal(profile.peak, 3);
  assert.equal(profile.coveredMs, 150);
  const byLevel = Object.fromEntries(profile.buckets.map((b) => [b.level, b.ms]));
  assert.equal(byLevel[1], 50 + 50); // 0-50 with a only, 100-150 with b only
  assert.equal(byLevel[2], 40); // 50-60 and 70-100
  assert.equal(byLevel[3], 10); // 60-70
});

test('touching spans across sessions do not read as overlap', () => {
  const mk = (id, spans) => ({
    sessionId: id,
    cwd: '/r',
    project: '/r',
    label: 'r',
    startedAt: 0,
    endedAt: 0,
    turns: 1,
    activeMs: 0,
    hasTurnData: true,
    prompts: 0,
    spans,
    file: `${id}.jsonl`,
    mtimeMs: 0,
    size: 0,
  });
  const profile = concurrencyProfile([mk('a', [span(0, 10)]), mk('b', [span(10, 20)])]);
  assert.equal(profile.peak, 1);
});

test('attribute folds a worktree back to its repo', () => {
  assert.deepEqual(attribute('/Users/me/dev/checkout/.claude/worktrees/more-tests'), {
    project: '/Users/me/dev/checkout',
    label: 'more-tests',
  });
});

test('attribute folds a subdirectory inside a worktree', () => {
  assert.deepEqual(attribute('/Users/me/dev/app/.claude/worktrees/feat/src/lib'), {
    project: '/Users/me/dev/app',
    label: 'feat',
  });
});

test('attribute leaves a plain directory alone', () => {
  assert.deepEqual(attribute('/Users/me/dev/app'), {
    project: '/Users/me/dev/app',
    label: 'app',
  });
});

test('attribute ignores a trailing slash', () => {
  assert.equal(attribute('/Users/me/dev/app/').project, '/Users/me/dev/app');
});

test('Anonymizer is stable and hides the original', () => {
  const on = new Anonymizer(true);
  const off = new Anonymizer(false);
  const a = on.projectLabel('/Users/me/clients/acme');
  const b = on.projectLabel('/Users/me/clients/acme');
  assert.equal(a, b, 'same input must give the same pseudonym');
  assert.ok(!a.includes('acme'));
  assert.notEqual(a, on.projectLabel('/Users/me/clients/other'));
  assert.equal(off.projectLabel('/Users/me/clients/acme'), 'acme');
});

test('parseEtime understands every ps duration shape', () => {
  assert.equal(parseEtime('01:23'), 83);
  assert.equal(parseEtime('01:52:13'), 6733);
  assert.equal(parseEtime('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseEtime('   01:52:13  '), 6733);
  assert.equal(parseEtime('nonsense'), null);
});

test('parseWindow accepts durations and rejects junk', () => {
  assert.equal(parseWindow('7d'), 7 * 86_400_000);
  assert.equal(parseWindow('24h'), 24 * 3_600_000);
  assert.equal(parseWindow('90m'), 90 * 60_000);
  assert.equal(parseWindow('0d'), null);
  assert.equal(parseWindow('later'), null);
});

test('duration formats at each magnitude', () => {
  assert.equal(duration(0), '0s');
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(90_000), '1m');
  assert.equal(duration(3_600_000), '1h');
  assert.equal(duration(5_400_000), '1h 30m');
  assert.equal(duration(90_000_000), '1d 1h');
});

test('computeStats clips to the window and keeps figures consistent', () => {
  const base = Date.parse('2026-08-10T12:00:00Z');
  const record = {
    sessionId: 's1',
    cwd: '/repo',
    project: '/repo',
    label: 'repo',
    startedAt: base,
    endedAt: base + 4 * 3_600_000,
    turns: 2,
    activeMs: 2 * 3_600_000,
    hasTurnData: true,
    prompts: 2,
    spans: [span(base, base + 3_600_000), span(base + 3 * 3_600_000, base + 4 * 3_600_000)],
    file: 'a.jsonl',
    mtimeMs: 0,
    size: 0,
  };

  const full = computeStats([record]);
  assert.equal(full.summary.activeMs, 2 * 3_600_000);
  assert.equal(full.summary.coveredMs, 2 * 3_600_000);
  assert.equal(full.summary.peakConcurrency, 1);
  assert.equal(full.summary.parallelism, 1);

  // Window covering only the first span.
  const half = computeStats([record], { from: base, to: base + 90 * 60_000 });
  assert.equal(half.summary.activeMs, 3_600_000);
  assert.equal(half.summary.sessions, 1);
});

test('computeStats reports sessions that carry no turn data', () => {
  const t = Date.parse('2026-08-10T12:00:00Z');
  const stats = computeStats([
    {
      sessionId: 'old',
      cwd: '/repo',
      project: '/repo',
      label: 'repo',
      startedAt: t,
      endedAt: t + 1000,
      turns: 0,
      activeMs: 0,
      hasTurnData: false,
      prompts: 1,
      spans: [],
      file: 'old.jsonl',
      mtimeMs: 0,
      size: 0,
    },
  ]);
  assert.equal(stats.summary.sessions, 1);
  assert.equal(stats.summary.sessionsWithoutTurnData, 1);
  assert.equal(stats.summary.activeMs, 0, 'no turn data must mean no invented active time');
});

test('computeStats handles an empty input', () => {
  const stats = computeStats([]);
  assert.equal(stats.summary.sessions, 0);
  assert.equal(stats.summary.parallelism, 0);
  assert.deepEqual(stats.concurrency, []);
});

test('dayKey is local-calendar based', () => {
  const t = new Date(2026, 7, 15, 13, 0, 0).getTime();
  assert.equal(dayKey(t), '2026-08-15');
});

test('a span crossing local midnight lands in both days', () => {
  const start = new Date(2026, 7, 15, 23, 30, 0).getTime();
  const end = new Date(2026, 7, 16, 0, 30, 0).getTime();
  const stats = computeStats([
    {
      sessionId: 'x',
      cwd: '/r',
      project: '/r',
      label: 'r',
      startedAt: start,
      endedAt: end,
      turns: 1,
      activeMs: end - start,
      hasTurnData: true,
      prompts: 1,
      spans: [span(start, end)],
      file: 'x.jsonl',
      mtimeMs: 0,
      size: 0,
    },
  ]);
  const days = Object.fromEntries(stats.days.map((d) => [d.day, d.activeMs]));
  assert.equal(days['2026-08-15'], 30 * 60_000);
  assert.equal(days['2026-08-16'], 30 * 60_000);
});
