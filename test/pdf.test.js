import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildPdf, encodeWinAnsi, fitText, PdfPage, textWidth } = await import(
  '../dist/render/pdf.js'
);
const { renderOnePager } = await import('../dist/render/onepager.js');
const { computeStats } = await import('../dist/stats.js');
const { Anonymizer } = await import('../dist/project.js');

const HOUR = 3_600_000;

/** A session working `spans` on real local days — day bucketing is local. */
const session = (over = {}) => ({
  sessionId: 's1',
  cwd: '/Users/me/clients/acme',
  project: '/Users/me/clients/acme',
  label: 'acme',
  version: '2.1.233',
  startedAt: 0,
  endedAt: 0,
  turns: 3,
  activeMs: 0,
  hasTurnData: true,
  prompts: 5,
  spans: [],
  file: '/t/s1.jsonl',
  mtimeMs: 1,
  size: 1,
  ...over,
});

/** A session that worked `hours` hours from 10:00 on the given local day. */
const onDay = (id, y, m, d, hours, over = {}) => {
  const start = new Date(y, m - 1, d, 10, 0, 0, 0).getTime();
  const end = start + hours * HOUR;
  return session({
    sessionId: id,
    startedAt: start,
    endedAt: end,
    activeMs: hours * HOUR,
    spans: [{ start, end }],
    ...over,
  });
};

const onePager = (records, anonymize = false) =>
  renderOnePager({
    stats: computeStats(records),
    anon: new Anonymizer(anonymize),
    windowLabel: 'Last 30d',
    generatedAt: Date.parse('2026-08-16T09:00:00.000Z'),
  });

/** The page's content stream, as a latin1 string. */
function contentStream(pdf) {
  const text = pdf.toString('latin1');
  const from = text.indexOf('stream\n');
  const to = text.indexOf('\nendstream');
  assert.ok(from > 0 && to > from, 'the document must carry a content stream');
  return text.slice(from + 'stream\n'.length, to);
}

const longDate = (y, m, d) =>
  new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

// ---------- the file itself ----------

test('the document is a well-formed single-page PDF', () => {
  const pdf = onePager([onDay('a', 2026, 7, 21, 4)]);
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'must declare its version first');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'must end with the EOF marker');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Count 1/);
  assert.equal((text.match(/\/Type \/Page[^s]/g) ?? []).length, 1, 'exactly one page');
});

test('every xref offset points at the object it claims', () => {
  const pdf = onePager([onDay('a', 2026, 7, 21, 4)]);
  const text = pdf.toString('latin1');

  const startxref = /startxref\n(\d+)\n%%EOF/.exec(text);
  assert.ok(startxref, 'trailer must carry startxref');
  assert.ok(text.startsWith('xref\n', Number(startxref[1])), 'startxref must land on the table');

  const table = text.slice(text.indexOf('xref\n'));
  const size = Number(/^xref\n0 (\d+)\n/.exec(table)[1]);
  const entries = [...table.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
  assert.equal(entries.length, size, 'one entry per object, plus the free head');

  entries.slice(1).forEach((entry, index) => {
    const at = Number(entry[1]);
    assert.ok(
      text.startsWith(`${index + 1} 0 obj`, at),
      `object ${index + 1} is not at its offset`,
    );
  });
});

test('the stream length in the dictionary is the real byte length', () => {
  const pdf = onePager([onDay('a', 2026, 7, 21, 4)]);
  const text = pdf.toString('latin1');
  const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)[1]);
  assert.equal(Buffer.byteLength(contentStream(pdf), 'latin1'), declared);
});

test('a hostile project name cannot break out of a PDF string', () => {
  // Unbalanced parentheses would end the literal early and corrupt everything after it.
  const evil = '/Users/me/nasty)(\\ name';
  const pdf = onePager([onDay('a', 2026, 7, 21, 4, { project: evil, label: evil, cwd: evil })]);
  const stream = contentStream(pdf);

  let depth = 0;
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    assert.ok(depth >= 0, 'a string closed that was never opened');
  }
  assert.equal(depth, 0, 'every PDF string must be closed');
});

// ---------- encoding and metrics ----------

test('text is mapped onto single WinAnsi bytes', () => {
  assert.equal(encodeWinAnsi('a·b–c×d…'), 'a\xb7b\x96c\xd7d\x85');
  for (const ch of encodeWinAnsi('Ångström · 90% · 2.4×')) {
    assert.ok(ch.charCodeAt(0) <= 0xff, `${ch} is not a single byte`);
  }
});

test('characters with no WinAnsi code degrade rather than disappear', () => {
  assert.equal(encodeWinAnsi('ā'), 'a', 'diacritics are stripped, the letter survives');
  assert.equal(encodeWinAnsi('≥1'), '>=1', 'a known symbol is spelled out');
  assert.equal(encodeWinAnsi('日本'), '??', 'anything else is a placeholder, never a broken byte');
});

test('glyph widths come from the real metrics, not an average', () => {
  assert.ok(textWidth('W', 'regular', 10) > textWidth('i', 'regular', 10) * 3);
  assert.ok(
    textWidth('Sessions', 'bold', 10) > textWidth('Sessions', 'regular', 10),
    'bold is wider than regular',
  );
  // Tracking is added between glyphs but not after the last one.
  assert.equal(textWidth('abc', 'regular', 10, 2), textWidth('abc', 'regular', 10) + 4);
});

test('fitText never returns something wider than the space it was given', () => {
  const long = 'a-very-long-repository-name-that-cannot-possibly-fit';
  for (const max of [20, 40, 80, 160]) {
    const fitted = fitText(long, 'regular', 9, max);
    assert.ok(textWidth(fitted, 'regular', 9) <= max, `"${fitted}" overflows ${max}pt`);
    assert.ok(fitted.endsWith('…'), 'a shortened string must say that it was shortened');
  }
  assert.equal(fitText('short', 'regular', 9, 200), 'short', 'text that fits is left alone');
});

test('buildPdf refuses to write a document with no pages', () => {
  assert.throws(() => buildPdf([], { title: 't', createdAt: 0 }), /at least one page/);
});

test('a page draws nothing for a box with neither fill nor stroke', () => {
  const page = new PdfPage(100, 100);
  page.box(0, 0, 10, 10, {});
  assert.equal(page.ops.length, 0);
});

// ---------- the one-pager ----------

test('the most productive day is the one with the most agent work', () => {
  const pdf = onePager([
    onDay('a', 2026, 7, 20, 1),
    onDay('b', 2026, 7, 21, 5),
    onDay('c', 2026, 7, 22, 2),
  ]);
  const stream = contentStream(pdf);
  assert.ok(stream.includes(longDate(2026, 7, 21)), 'the busiest day must be the one named');
  assert.ok(!stream.includes(longDate(2026, 7, 22)), 'a quieter day must not be');
});

test('a tie for the most productive day goes to the more recent one', () => {
  const pdf = onePager([onDay('a', 2026, 7, 20, 3), onDay('b', 2026, 7, 22, 3)]);
  assert.ok(contentStream(pdf).includes(longDate(2026, 7, 22)));
});

test('parallel work on the best day is counted once per session', () => {
  // Two sessions overlapping all afternoon: 8h of agent work, peak 2, not 2 sessions of peak.
  const pdf = onePager([onDay('a', 2026, 7, 21, 4), onDay('b', 2026, 7, 21, 4, { label: 'b' })]);
  const stream = contentStream(pdf);
  assert.ok(stream.includes('(8h)'), 'summed working time');
  assert.ok(stream.includes('(2)'), 'peak of two agents at once');
});

test('--anonymize keeps client names out of the PDF bytes', () => {
  const records = [onDay('a', 2026, 7, 21, 4)];
  assert.ok(onePager(records).toString('latin1').includes('acme'), 'sanity: the name is there');

  const hidden = onePager(records, true).toString('latin1');
  assert.ok(!hidden.includes('acme'), 'the project name must not survive');
  assert.match(hidden, /project-[0-9a-f]{6}/);
});

test('an empty window still produces a valid page that says so', () => {
  const pdf = onePager([]);
  const stream = contentStream(pdf);
  assert.match(stream, /No sessions in this window/);
  assert.ok(!stream.includes('NaN'), 'no arithmetic may leak into the page');
  assert.ok(!stream.includes('undefined'));
});

test('sessions with no turn data report zero rather than an estimate', () => {
  const start = new Date(2026, 6, 21, 10, 0, 0, 0).getTime();
  const pdf = onePager([
    session({
      sessionId: 'old',
      startedAt: start,
      endedAt: start + 6 * HOUR,
      hasTurnData: false,
      turns: 0,
      activeMs: 0,
      spans: [],
    }),
  ]);
  const stream = contentStream(pdf);
  assert.match(stream, /nothing to chart/, 'the page has to say why it is empty');
  assert.match(stream, /2\.1\.222/, 'and why the time is missing');
});

test('the page never spills onto a second sheet, however much there is to show', () => {
  const records = [];
  for (let day = 1; day <= 28; day++) {
    for (let n = 0; n < 3; n++) {
      records.push(
        onDay(`s${day}-${n}`, 2026, 7, day, 2 + n, {
          project: `/Users/me/projects/project-number-${(day * 3 + n) % 40}`,
          label: `project-number-${(day * 3 + n) % 40}`,
        }),
      );
    }
  }
  const pdf = onePager(records);
  const text = pdf.toString('latin1');
  assert.equal((text.match(/\/Type \/Page[^s]/g) ?? []).length, 1);
  assert.match(text, /\/Count 1/);

  // Everything drawn has to land on the sheet: A4 is 595.28 x 841.89 points.
  for (const [, x, y] of contentStream(pdf).matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
    assert.ok(Number(x) >= 0 && Number(x) <= 595.28, `text at x=${x} is off the page`);
    assert.ok(Number(y) >= 0 && Number(y) <= 841.89, `text at y=${y} is off the page`);
  }
});

test('the tail of the project list is summed, never silently dropped', () => {
  const records = [];
  for (let n = 0; n < 20; n++) {
    records.push(
      onDay(`s${n}`, 2026, 7, 21, 20 - n, {
        project: `/Users/me/projects/p${n}`,
        label: `p${n}`,
      }),
    );
  }
  assert.match(contentStream(onePager(records)), /\(\d+ others\)/);
});
