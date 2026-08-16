import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agentclock-tx-'));
process.env.CLAUDE_CONFIG_DIR = root;

const { parseTranscript, listTranscripts, scanTranscripts } = await import(
  '../dist/transcripts.js'
);

const PROJECTS = path.join(root, 'projects');
const SLUG = '-Users-me-dev-app';
const iso = (s) => new Date(s).toISOString();

/** Records shaped like the ones Claude Code actually writes. */
const prompt = (sessionId, cwd, at, version = '2.1.233') =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'do the thing' },
    promptSource: 'typed',
    origin: { kind: 'human' },
    timestamp: iso(at),
    sessionId,
    cwd,
    version,
  });

/** A tool result is also type "user" but carries no promptSource — must not count. */
const toolResult = (sessionId, cwd, at) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
    toolUseResult: 'ok',
    timestamp: iso(at),
    sessionId,
    cwd,
  });

const attachment = (sessionId, at) =>
  JSON.stringify({
    type: 'attachment',
    attachment: { type: 'total_tokens_reminder', text: 'x' },
    timestamp: iso(at),
    sessionId,
  });

const turn = (sessionId, cwd, endAt, durationMs) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    messageCount: 12,
    timestamp: iso(endAt),
    sessionId,
    cwd,
  });

async function writeTranscript(slug, name, lines) {
  const dir = path.join(PROJECTS, slug);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const st = await stat(file);
  return { file, mtimeMs: st.mtimeMs, size: st.size };
}

const T0 = Date.parse('2026-08-10T09:00:00.000Z');
const MIN = 60_000;

before(async () => {
  await mkdir(PROJECTS, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('parses a well-formed transcript', async () => {
  const tf = await writeTranscript(SLUG, 'sess-a.jsonl', [
    prompt('sess-a', '/Users/me/dev/app', T0),
    attachment('sess-a', T0 + 1000),
    toolResult('sess-a', '/Users/me/dev/app', T0 + 2000),
    turn('sess-a', '/Users/me/dev/app', T0 + 5 * MIN, 5 * MIN),
    prompt('sess-a', '/Users/me/dev/app', T0 + 20 * MIN),
    turn('sess-a', '/Users/me/dev/app', T0 + 30 * MIN, 10 * MIN),
  ]);

  const { record } = await parseTranscript(tf);
  assert.ok(record);
  assert.equal(record.sessionId, 'sess-a');
  assert.equal(record.cwd, '/Users/me/dev/app');
  assert.equal(record.version, '2.1.233');
  assert.equal(record.project, '/Users/me/dev/app');
  assert.equal(record.turns, 2);
  assert.equal(record.hasTurnData, true);
  assert.equal(record.activeMs, 15 * MIN);
  assert.equal(record.prompts, 2, 'tool results must not count as human prompts');
});

test('a turn span ends at its timestamp and starts durationMs earlier', async () => {
  const end = T0 + 60 * MIN;
  const tf = await writeTranscript(SLUG, 'sess-span.jsonl', [
    prompt('sess-span', '/Users/me/dev/app', T0),
    turn('sess-span', '/Users/me/dev/app', end, 6 * MIN),
  ]);

  const { record } = await parseTranscript(tf);
  assert.deepEqual(record.spans, [{ start: end - 6 * MIN, end }]);
});

test('overlapping turns are merged, never double-counted', async () => {
  // Two turns whose recorded durations overlap: 10 min of wall clock, not 15.
  const tf = await writeTranscript(SLUG, 'sess-overlap.jsonl', [
    prompt('sess-overlap', '/Users/me/dev/app', T0),
    turn('sess-overlap', '/Users/me/dev/app', T0 + 10 * MIN, 10 * MIN),
    turn('sess-overlap', '/Users/me/dev/app', T0 + 10 * MIN, 5 * MIN),
  ]);

  const { record } = await parseTranscript(tf);
  assert.equal(record.turns, 2, 'both turns are still counted');
  assert.equal(record.activeMs, 10 * MIN, 'but their overlapping time is not');
  assert.equal(record.spans.length, 1);
});

test('a session with no turn_duration reports no active time rather than a guess', async () => {
  const tf = await writeTranscript(SLUG, 'sess-old.jsonl', [
    prompt('sess-old', '/Users/me/dev/app', T0, '2.1.221'),
    attachment('sess-old', T0 + MIN),
    toolResult('sess-old', '/Users/me/dev/app', T0 + 40 * MIN),
  ]);

  const { record } = await parseTranscript(tf);
  assert.equal(record.hasTurnData, false);
  assert.equal(record.activeMs, 0);
  assert.equal(record.turns, 0);
  assert.deepEqual(record.spans, []);
  // Lifetime is still known, because record timestamps still exist.
  assert.equal(record.endedAt - record.startedAt, 40 * MIN);
});

test('malformed lines are skipped without losing the rest', async () => {
  const tf = await writeTranscript(SLUG, 'sess-broken.jsonl', [
    prompt('sess-broken', '/Users/me/dev/app', T0),
    '{ this is not json',
    '',
    turn('sess-broken', '/Users/me/dev/app', T0 + 8 * MIN, 8 * MIN),
    '{"type":"system","subtype":"turn_duration"}', // no durationMs
    '{"type":"system","subtype":"turn_duration","durationMs":-5,"timestamp":"nope"}',
  ]);

  const { record } = await parseTranscript(tf);
  assert.equal(record.turns, 1);
  assert.equal(record.activeMs, 8 * MIN);
});

test('a worktree session is attributed to its repository', async () => {
  const cwd = '/Users/me/dev/app/.claude/worktrees/feature-x';
  const tf = await writeTranscript(SLUG, 'sess-wt.jsonl', [
    prompt('sess-wt', cwd, T0),
    turn('sess-wt', cwd, T0 + 3 * MIN, 3 * MIN),
  ]);

  const { record } = await parseTranscript(tf);
  assert.equal(record.cwd, cwd, 'raw cwd is preserved for auditability');
  assert.equal(record.project, '/Users/me/dev/app');
  assert.equal(record.label, 'feature-x');
});

test('a transcript with no usable records yields nothing', async () => {
  const tf = await writeTranscript(SLUG, 'sess-empty.jsonl', ['', '{}']);
  const { record } = await parseTranscript(tf);
  assert.equal(record, null);
});

test('subagent transcripts are excluded from the session list', async () => {
  // Subagents live one level deeper and share the parent's sessionId. Counting
  // them would break "N subagents = 1 session".
  const subDir = path.join(PROJECTS, SLUG, 'sess-a', 'subagents');
  await mkdir(subDir, { recursive: true });
  await writeFile(
    path.join(subDir, 'agent-abc123.jsonl'),
    `${turn('sess-a', '/Users/me/dev/app', T0 + MIN, MIN)}\n`,
    'utf8',
  );

  const files = await listTranscripts();
  assert.ok(files.length > 0);
  assert.equal(
    files.filter((f) => f.file.includes('subagents')).length,
    0,
    'no subagent transcript may appear in the session list',
  );
});

test('the prefilter keeps full JSON parsing to a small fraction of lines', async () => {
  const noise = Array.from({ length: 400 }, (_, i) => attachment('sess-noise', T0 + i));
  const tf = await writeTranscript(SLUG, 'sess-noise.jsonl', [
    prompt('sess-noise', '/Users/me/dev/app', T0),
    ...noise,
    turn('sess-noise', '/Users/me/dev/app', T0 + 9 * MIN, 9 * MIN),
  ]);

  const result = await parseTranscript(tf);
  assert.equal(result.lines, 402);
  assert.ok(
    result.parsed < 10,
    `expected the substring prefilter to skip nearly every line, parsed ${result.parsed}`,
  );
});

test('scanTranscripts honours skip and reports what it skipped', async () => {
  const all = await scanTranscripts({});
  assert.ok(all.records.length >= 6);
  assert.equal(all.skipped, 0);

  const skipEverything = await scanTranscripts({ skip: () => true });
  assert.equal(skipEverything.records.length, 0);
  assert.equal(skipEverything.scanned, 0);
  assert.equal(skipEverything.skipped, all.scanned);
});

test('scanTranscripts survives a directory that does not exist', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'nope');
  try {
    const result = await scanTranscripts({});
    assert.deepEqual(result.records, []);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
