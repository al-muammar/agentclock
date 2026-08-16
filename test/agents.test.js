import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agentclock-codex-'));
const claudeRootDir = await mkdtemp(path.join(tmpdir(), 'agentclock-claude-'));
process.env.CODEX_HOME = root;
process.env.CLAUDE_CONFIG_DIR = claudeRootDir;

const { parseRollout, listRollouts, codexAdapter } = await import('../dist/agents/codex.js');
const { claudeAdapter } = await import('../dist/agents/claude.js');
const { ADAPTERS, resolveAgents, describeAgents, readLive, agentName } = await import(
  '../dist/agents/index.js'
);
const { scanSessions } = await import('../dist/scan.js');
const { computeStats, agentBuckets, concurrencyProfile } = await import('../dist/stats.js');

const SESSIONS = path.join(root, 'sessions', '2026', '08', '10');
const T0 = Date.parse('2026-08-10T09:00:00.000Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();

/** Codex's RolloutLine: a top-level timestamp, a variant tag, and a payload. */
const line = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload });

const meta = (at, id, cwd, version = '0.130.0') =>
  line(at, 'session_meta', {
    id,
    timestamp: iso(at),
    cwd,
    originator: 'codex_cli_rs',
    cli_version: version,
    git: { sha: 'abc123', branch: 'main' },
  });

const started = (at) => line(at, 'event_msg', { type: 'task_started', turn_id: 't1' });

/** A completed turn carrying its own measured bounds — the precise case. */
const complete = (startAt, endAt) =>
  line(endAt, 'event_msg', {
    type: 'task_complete',
    turn_id: 't1',
    started_at: iso(startAt),
    completed_at: iso(endAt),
    duration_ms: endAt - startAt,
    last_agent_message: 'done',
  });

const userMessage = (at, text) => line(at, 'event_msg', { type: 'user_message', message: text });
const tokenCount = (at) => line(at, 'event_msg', { type: 'token_count', info: { total: 42 } });

/** The bulk of a real rollout: tool calls and their output. Never parsed. */
const responseItem = (at, text) =>
  line(at, 'response_item', {
    type: 'function_call_output',
    call_id: 'call_1',
    output: text,
  });

async function writeRollout(name, lines) {
  await mkdir(SESSIONS, { recursive: true });
  const file = path.join(SESSIONS, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const st = await stat(file);
  return { file, mtimeMs: st.mtimeMs, size: st.size };
}

before(async () => {
  await mkdir(SESSIONS, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(claudeRootDir, { recursive: true, force: true });
});

// ---------- codex parsing ----------

test('parses a well-formed codex rollout', async () => {
  const file = await writeRollout(
    'rollout-2026-08-10T09-00-00-11111111-1111-4111-8111-111111111111.jsonl',
    [
      meta(T0, 'sess-cx', '/Users/me/dev/api'),
      userMessage(T0 + 1000, 'do the thing'),
      started(T0 + 2000),
      responseItem(T0 + 3000, 'a lot of tool output'),
      tokenCount(T0 + 4000),
      complete(T0 + 2000, T0 + 7 * MIN),
      userMessage(T0 + 8 * MIN, 'and again'),
      started(T0 + 9 * MIN),
      complete(T0 + 9 * MIN, T0 + 12 * MIN),
    ],
  );

  const { record } = await parseRollout(file);
  assert.ok(record);
  assert.equal(record.agent, 'codex');
  assert.equal(record.sessionId, 'sess-cx');
  assert.equal(record.cwd, '/Users/me/dev/api');
  assert.equal(record.project, '/Users/me/dev/api');
  assert.equal(record.version, '0.130.0');
  assert.equal(record.turns, 2);
  assert.equal(record.hasTurnData, true);
  assert.equal(record.activeMs, 7 * MIN - 2000 + 3 * MIN);
  assert.equal(record.prompts, 2, 'only user_message events count as human prompts');
});

test('turn bounds are preferred over duration_ms, and duration_ms over line pairing', async () => {
  // Three turns, each exercising one rung of the precision ladder.
  const file = await writeRollout('rollout-ladder-22222222-2222-4222-8222-222222222222.jsonl', [
    meta(T0, 'sess-ladder', '/repo'),
    // 1. explicit bounds
    complete(T0 + MIN, T0 + 3 * MIN),
    // 2. duration_ms only, measured back from the line stamp
    line(T0 + 10 * MIN, 'event_msg', { type: 'task_complete', duration_ms: 2 * MIN }),
    // 3. neither: pair the started line with the complete line
    started(T0 + 20 * MIN),
    line(T0 + 24 * MIN, 'event_msg', { type: 'task_complete' }),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.turns, 3);
  assert.deepEqual(record.spans, [
    { start: T0 + MIN, end: T0 + 3 * MIN },
    { start: T0 + 8 * MIN, end: T0 + 10 * MIN },
    { start: T0 + 20 * MIN, end: T0 + 24 * MIN },
  ]);
});

test('the newer turn_complete wire name is read too', async () => {
  const file = await writeRollout('rollout-rename-33333333-3333-4333-8333-333333333333.jsonl', [
    meta(T0, 'sess-rename', '/repo'),
    line(T0, 'event_msg', { type: 'turn_started' }),
    line(T0 + 5 * MIN, 'event_msg', {
      type: 'turn_complete',
      started_at: iso(T0),
      completed_at: iso(T0 + 5 * MIN),
      duration_ms: 5 * MIN,
    }),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.turns, 1);
  assert.equal(record.activeMs, 5 * MIN);
});

test('a rollout with no turn events reports no active time rather than a guess', async () => {
  const file = await writeRollout('rollout-old-44444444-4444-4444-8444-444444444444.jsonl', [
    meta(T0, 'sess-old-cx', '/repo'),
    userMessage(T0 + MIN, 'hello'),
    responseItem(T0 + 30 * MIN, 'output'),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.hasTurnData, false);
  assert.equal(record.activeMs, 0);
  assert.equal(record.turns, 0);
  assert.deepEqual(record.spans, []);
  // The lifetime is still known — it comes from record timestamps, not from work.
  assert.equal(record.endedAt - record.startedAt, 30 * MIN);
});

test('an unmatched task_started is not paired with a later turn', async () => {
  // A crash between start and completion must not donate its dead time to the
  // next turn, which would invent working time out of an interrupted session.
  const file = await writeRollout('rollout-crash-55555555-5555-4555-8555-555555555555.jsonl', [
    meta(T0, 'sess-crash', '/repo'),
    started(T0),
    started(T0 + 50 * MIN),
    line(T0 + 52 * MIN, 'event_msg', { type: 'task_complete' }),
  ]);

  const { record } = await parseRollout(file);
  assert.deepEqual(record.spans, [{ start: T0 + 50 * MIN, end: T0 + 52 * MIN }]);
});

test('overlapping codex turns are merged, never double-counted', async () => {
  const file = await writeRollout('rollout-overlap-66666666-6666-4666-8666-666666666666.jsonl', [
    meta(T0, 'sess-cx-overlap', '/repo'),
    complete(T0, T0 + 10 * MIN),
    complete(T0 + 5 * MIN, T0 + 10 * MIN),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.turns, 2, 'both turns are still counted');
  assert.equal(record.activeMs, 10 * MIN, 'but their overlapping time is not');
  assert.equal(record.spans.length, 1);
});

test('a rollout whose session_meta was lost still gets its id from the filename', async () => {
  const uuid = '77777777-7777-4777-8777-777777777777';
  const file = await writeRollout(`rollout-2026-08-10T09-00-00-${uuid}.jsonl`, [
    '{ torn write, not json',
    complete(T0, T0 + MIN),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.sessionId, uuid);
  assert.equal(record.cwd, '(unknown)', 'nothing in the path encodes a working directory');
});

test('malformed codex lines are skipped without losing the rest', async () => {
  const file = await writeRollout('rollout-broken-88888888-8888-4888-8888-888888888888.jsonl', [
    meta(T0, 'sess-cx-broken', '/repo'),
    '{ not json at all',
    '',
    complete(T0, T0 + 4 * MIN),
    line(T0 + 5 * MIN, 'event_msg', { type: 'task_complete', duration_ms: -5 }),
    line(T0 + 6 * MIN, 'event_msg', { type: 'task_complete', duration_ms: 0 }),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.turns, 1);
  assert.equal(record.activeMs, 4 * MIN);
});

test('a prompt that quotes the turn markers cannot fabricate a turn', async () => {
  // Someone asking Codex about its own rollout format types these strings. The
  // prefilter finds them; only the parsed payload type may decide.
  const file = await writeRollout('rollout-quote-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl', [
    meta(T0, 'sess-quote', '/repo'),
    userMessage(T0 + MIN, 'what does {"type":"task_complete","duration_ms":999999} mean?'),
    responseItem(T0 + 2 * MIN, 'the "type":"turn_complete" event ends a turn'),
    complete(T0 + 3 * MIN, T0 + 4 * MIN),
  ]);

  const { record } = await parseRollout(file);
  assert.equal(record.turns, 1, 'only the real completion counts');
  assert.equal(record.activeMs, MIN);
  assert.equal(record.prompts, 1);
});

test('the codex prefilter keeps full JSON parsing to a small fraction of lines', async () => {
  const noise = Array.from({ length: 400 }, (_, i) => responseItem(T0 + i, 'tool output'));
  const file = await writeRollout('rollout-noise-99999999-9999-4999-8999-999999999999.jsonl', [
    meta(T0, 'sess-cx-noise', '/repo'),
    ...noise,
    complete(T0, T0 + 9 * MIN),
  ]);

  const result = await parseRollout(file);
  assert.equal(result.lines, 402);
  assert.ok(
    result.parsed < 10,
    `expected the substring prefilter to skip nearly every line, parsed ${result.parsed}`,
  );
});

// ---------- listing ----------

test('rollouts are found through the YYYY/MM/DD layout', async () => {
  const { files } = await listRollouts();
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => f.file.endsWith('.jsonl')));
});

test('compressed rollouts are counted and reported, not silently dropped', async () => {
  await writeFile(path.join(SESSIONS, 'rollout-cold.jsonl.zst'), 'not readable', 'utf8');
  const listing = await listRollouts();
  assert.ok(listing.unreadable);
  assert.equal(listing.unreadable.count, 1);
  assert.match(listing.unreadable.reason, /zstd/);
  assert.ok(
    listing.files.every((f) => !f.file.endsWith('.zst')),
    'a file we cannot read must not enter the work queue',
  );
});

test('the codex adapter survives a sessions directory that does not exist', async () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'nope');
  try {
    const listing = await listRollouts();
    assert.deepEqual(listing.files, []);
    assert.equal(await codexAdapter.detect(), false);
  } finally {
    process.env.CODEX_HOME = previous;
  }
});

// ---------- registry ----------

test('every adapter has a distinct id and either live support or a reason', () => {
  const ids = ADAPTERS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique — the archive keys on them');
  for (const adapter of ADAPTERS) {
    if (typeof adapter.live !== 'function') {
      assert.ok(adapter.liveNote, `${adapter.id} must explain why it cannot report live state`);
    }
  }
});

test('resolveAgents honours an explicit selection and rejects an unknown one', async () => {
  const one = await resolveAgents(['codex']);
  assert.deepEqual(
    one.adapters.map((a) => a.id),
    ['codex'],
  );

  const both = await resolveAgents(['codex', 'claude', 'codex']);
  assert.deepEqual(
    both.adapters.map((a) => a.id),
    ['codex', 'claude'],
    'duplicates collapse, order follows the request',
  );

  const bad = await resolveAgents(['nope']);
  assert.match(bad.error, /Unknown agent: nope/);
  assert.deepEqual(bad.adapters, []);
});

test('describeAgents reports where each agent lives', async () => {
  const infos = await describeAgents();
  const codex = infos.find((i) => i.id === 'codex');
  assert.equal(codex.root, root);
  assert.equal(codex.live, false);
  assert.ok(codex.liveNote);

  const claude = infos.find((i) => i.id === 'claude');
  assert.equal(claude.live, true);
});

test('an agent with no live source is named rather than silently omitted', async () => {
  const snapshot = await readLive([codexAdapter]);
  assert.deepEqual(snapshot.sessions, []);
  assert.equal(snapshot.blind.length, 1);
  assert.equal(snapshot.blind[0].id, 'codex');
  assert.match(snapshot.blind[0].note, /live session registry/);
});

test('agentName falls back to the raw id for an agent we no longer ship', () => {
  assert.equal(agentName('claude'), 'Claude Code');
  assert.equal(agentName('some-retired-agent'), 'some-retired-agent');
});

// ---------- the scanner across agents ----------

test('a scan interleaves agents and tags every record with its own', async () => {
  const claudeProjects = path.join(claudeRootDir, 'projects', '-repo');
  await mkdir(claudeProjects, { recursive: true });
  await writeFile(
    path.join(claudeProjects, 'sess-cl.jsonl'),
    `${JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 6 * MIN,
      timestamp: iso(T0 + 6 * MIN),
      sessionId: 'sess-cl',
      cwd: '/repo',
      version: '2.1.233',
    })}\n`,
    'utf8',
  );

  const scan = await scanSessions([claudeAdapter, codexAdapter]);
  const agents = new Set(scan.records.map((r) => r.agent));
  assert.ok(agents.has('claude'));
  assert.ok(agents.has('codex'));

  const perAgent = Object.fromEntries(scan.agents.map((a) => [a.agent, a]));
  assert.equal(perAgent.claude.found, 1);
  assert.ok(perAgent.codex.found > 1);
  assert.equal(perAgent.codex.unreadable, 1, 'the compressed rollout is reported here');
});

test('a broken adapter cannot take the whole scan down', async () => {
  const exploding = {
    id: 'boom',
    name: 'Boom',
    root: () => '/nowhere',
    detect: async () => true,
    list: async () => {
      throw new Error('disk on fire');
    },
    parse: async () => ({ record: null, lines: 0, parsed: 0 }),
  };

  const scan = await scanSessions([exploding, codexAdapter]);
  assert.ok(scan.records.length > 0, 'codex records still come through');
});

// ---------- multi-agent stats ----------

const record = (agent, id, project, spans) => ({
  agent,
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

test('a claude session and a codex session working at once count as two', () => {
  const stats = computeStats([
    record('claude', 'a', '/repo', [{ start: T0, end: T0 + 10 * MIN }]),
    record('codex', 'b', '/repo', [{ start: T0 + 5 * MIN, end: T0 + 15 * MIN }]),
  ]);

  assert.equal(stats.summary.peakConcurrency, 2);
  assert.equal(stats.summary.agents, 2);
  assert.equal(stats.summary.activeMs, 20 * MIN);
  assert.equal(stats.summary.coveredMs, 15 * MIN, 'wall clock is the union, not the sum');
});

test('two agents that mint the same session id are still two sessions', () => {
  // Nothing coordinates ids across agents. Keying on the bare id would let one
  // session close the other's interval and halve the concurrency.
  const profile = concurrencyProfile([
    record('claude', 'same-id', '/repo', [{ start: T0, end: T0 + 10 * MIN }]),
    record('codex', 'same-id', '/other', [{ start: T0, end: T0 + 10 * MIN }]),
  ]);

  assert.equal(profile.peak, 2);
  assert.equal(profile.coveredMs, 10 * MIN);
});

test('agent buckets split the window and keep each agent’s own wall clock', () => {
  const buckets = agentBuckets([
    record('claude', 'a', '/repo', [{ start: T0, end: T0 + 10 * MIN }]),
    record('claude', 'b', '/repo', [{ start: T0 + 5 * MIN, end: T0 + 15 * MIN }]),
    record('codex', 'c', '/api', [{ start: T0, end: T0 + 4 * MIN }]),
  ]);

  assert.deepEqual(
    buckets.map((b) => b.agent),
    ['claude', 'codex'],
    'busiest agent first',
  );
  const [claude, codex] = buckets;
  assert.equal(claude.sessions, 2);
  assert.equal(claude.activeMs, 20 * MIN);
  assert.equal(claude.coveredMs, 15 * MIN, "one agent's own overlap is merged away");
  assert.equal(codex.activeMs, 4 * MIN);
  assert.equal(codex.projects, 1);
});

test('a project worked by both agents lists both, busiest first', () => {
  const stats = computeStats([
    record('codex', 'c', '/repo', [{ start: T0, end: T0 + 2 * MIN }]),
    record('claude', 'a', '/repo', [{ start: T0 + 10 * MIN, end: T0 + 30 * MIN }]),
  ]);

  assert.deepEqual(stats.projects[0].agents, ['claude', 'codex']);
});

test('intervals name which agents were working, for the timeline tooltip', () => {
  const { intervals } = concurrencyProfile([
    record('claude', 'a', '/repo', [{ start: T0, end: T0 + 10 * MIN }]),
    record('codex', 'b', '/api', [{ start: T0 + 5 * MIN, end: T0 + 15 * MIN }]),
  ]);

  const overlap = intervals.find((i) => i.level === 2);
  assert.deepEqual([...overlap.agents].sort(), ['claude', 'codex']);
});
