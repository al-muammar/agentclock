import { test } from 'node:test';
import assert from 'node:assert/strict';

const { esc, hBarChart, vBarChart } = await import('../dist/render/svg.js');
const { renderReport } = await import('../dist/render/html.js');
const { computeStats } = await import('../dist/stats.js');
const { Anonymizer } = await import('../dist/project.js');
const { parseArgs } = await import('../dist/cli.js');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-10T09:00:00.000Z');

const session = (over = {}) => ({
  sessionId: 's1',
  cwd: '/Users/me/clients/acme',
  project: '/Users/me/clients/acme',
  label: 'acme',
  version: '2.1.233',
  startedAt: T0,
  endedAt: T0 + 4 * HOUR,
  turns: 3,
  activeMs: 2 * HOUR,
  hasTurnData: true,
  prompts: 5,
  spans: [
    { start: T0, end: T0 + HOUR },
    { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR },
  ],
  file: '/t/s1.jsonl',
  mtimeMs: 1,
  size: 1,
  ...over,
});

const report = (records, live = [], anonymize = false) =>
  renderReport({
    stats: computeStats(records),
    live,
    anon: new Anonymizer(anonymize),
    windowLabel: 'Last 30d',
    generatedAt: T0,
  });

// ---------- escaping ----------

test('esc neutralises every markup-significant character', () => {
  assert.equal(esc(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
});

test('a hostile project name cannot inject markup into the report', () => {
  const evil = '/Users/me/<script>alert(1)</script>';
  const html = report([session({ project: evil, label: evil, cwd: evil })]);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'it should appear escaped instead');
});

// ---------- svg primitives ----------

test('hBarChart scales bars against the largest value', () => {
  const svg = hBarChart([
    { label: 'a', value: 100, display: '100' },
    { label: 'b', value: 50, display: '50' },
  ]);
  const widths = [...svg.matchAll(/class="bar-busy"[^>]*width="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(widths.length, 2);
  assert.ok(Math.abs(widths[0] / widths[1] - 2) < 0.05, 'twice the value, twice the width');
});

test('hBarChart keeps a small non-zero value visible', () => {
  const svg = hBarChart([
    { label: 'big', value: 100000, display: 'big' },
    { label: 'tiny', value: 1, display: 'tiny' },
  ]);
  const widths = [...svg.matchAll(/class="bar-busy"[^>]*width="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(widths[1] >= 3, 'a positive value must never render as nothing');
});

test('hBarChart renders nothing at all for a zero value', () => {
  const svg = hBarChart([{ label: 'none', value: 0, display: '0' }]);
  assert.equal([...svg.matchAll(/class="bar-busy"/g)].length, 0);
});

test('hBarChart returns empty string for no items', () => {
  assert.equal(hBarChart([]), '');
  assert.equal(vBarChart([]), '');
});

test('charts carry an accessible label and per-mark titles', () => {
  const svg = hBarChart([{ label: 'alpha', value: 5, display: '5', title: 'alpha is 5' }]);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="/);
  assert.match(svg, /<title>alpha is 5<\/title>/);
});

test('chart labels are escaped', () => {
  const svg = hBarChart([{ label: '<b>x</b>', value: 1, display: '&' }]);
  assert.ok(!svg.includes('<b>x</b>'));
  assert.ok(svg.includes('&lt;b&gt;'));
});

// ---------- the report document ----------

test('the report is self-contained: no scripts, no network', () => {
  const html = report([session()]);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/https?:\/\//.test(html), 'no external URLs');
  assert.ok(!/\ssrc=/.test(html), 'no external resources');
});

test('the report defines both themes and declares color-scheme', () => {
  const html = report([session()]);
  // Without color-scheme, Chrome auto-darkening re-inverts the SVG fills.
  assert.match(html, /color-scheme:\s*light dark/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
});

test('the report never leaks NaN or undefined into the output', () => {
  const html = report([session(), session({ sessionId: 's2', activeMs: 0, spans: [], turns: 0 })]);
  assert.ok(!/NaN/.test(html));
  assert.ok(!/undefined/.test(html));
});

test('an empty dataset still produces a valid document', () => {
  const html = report([]);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<\/html>/);
  assert.ok(!/NaN/.test(html));
});

test('block level tags are balanced', () => {
  const html = report([session()], []);
  for (const tag of ['div', 'section', 'figure', 'table', 'svg', 'g', 'tr', 'td', 'thead']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `unbalanced <${tag}>`);
  }
});

test('--anonymize keeps client names out of the report', () => {
  const plain = report([session()]);
  assert.ok(plain.includes('acme'), 'sanity: the name appears when not anonymising');

  const hidden = report([session()], [], true);
  assert.ok(!hidden.includes('acme'), 'project name must not survive anonymisation');
  assert.match(hidden, /project-[0-9a-f]{6}/);
});

test('the report states that historical waiting time is absent', () => {
  // The number is missing on purpose; the document has to say so.
  const html = report([session()]);
  assert.match(html, /waiting/i);
  assert.match(html, /cannot be recovered|not shown/i);
});

test('sessions predating turn_duration are called out, not silently zeroed', () => {
  const html = report([
    session({ sessionId: 'old', hasTurnData: false, activeMs: 0, spans: [], turns: 0 }),
  ]);
  assert.match(html, /2\.1\.222/);
});

test('live sessions render with their state and waitingFor detail', () => {
  const html = report(
    [session()],
    [
      {
        pid: 1,
        sessionId: 'live-1',
        cwd: '/Users/me/dev/app',
        startedAt: T0,
        status: 'waiting',
        kind: 'interactive',
        name: 'my-session',
        waitingFor: 'input needed',
      },
    ],
  );
  assert.match(html, /Right now/);
  assert.match(html, /my-session/);
  assert.match(html, /input needed/);
});

test('an unknown live status is surfaced rather than folded into idle', () => {
  const html = report(
    [session()],
    [
      {
        pid: 2,
        sessionId: 'live-2',
        cwd: '/Users/me/dev/app',
        startedAt: T0,
        status: 'something-new',
        kind: 'interactive',
        name: 'odd',
      },
    ],
  );
  assert.match(html, /unknown state/i);
});

// ---------- flags introduced with the dashboard ----------

test('-o and --out resolve to an absolute path', () => {
  const a = parseArgs(['-o', 'out.html']).options;
  const b = parseArgs(['--out=out.html']).options;
  assert.ok(a.out.startsWith('/'));
  assert.equal(a.out, b.out);
});

test('--out with no value is an error', () => {
  assert.match(parseArgs(['--out']).error ?? '', /needs a file path/i);
});

test('--no-open turns off opening but stays on by default', () => {
  assert.equal(parseArgs([]).options.open, true);
  assert.equal(parseArgs(['--no-open']).options.open, false);
});

test('the default command builds the report', () => {
  assert.equal(parseArgs([]).options.command, 'report');
});
