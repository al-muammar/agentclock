import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'agentclock-test-'));
process.env.AGENTCLOCK_DIR = dir;

const { loadArchive, saveArchive, mergeArchive, emptyArchive, sessionKey } = await import(
  '../dist/archive.js'
);
const { archivePath } = await import('../dist/paths.js');

const session = (over = {}) => ({
  agent: 'claude',
  sessionId: 's1',
  cwd: '/repo',
  project: '/repo',
  label: 'repo',
  version: '2.1.233',
  startedAt: 1000,
  endedAt: 5000,
  turns: 2,
  activeMs: 1500,
  hasTurnData: true,
  prompts: 3,
  spans: [
    { start: 1000, end: 2000 },
    { start: 3000, end: 3500 },
  ],
  file: '/transcripts/s1.jsonl',
  mtimeMs: 111,
  size: 222,
  ...over,
});

test('a saved session round-trips exactly', async () => {
  const original = session();
  await saveArchive([original]);
  const archive = await loadArchive();

  assert.equal(archive.bySession.size, 1);
  assert.deepEqual(archive.bySession.get('claude:s1'), original);
  assert.deepEqual(archive.byFile.get('/transcripts/s1.jsonl'), { mtimeMs: 111, size: 222 });
});

test('archive survives the transcript being deleted', async () => {
  // The whole point: Claude Code sweeps transcripts after 30 days.
  await saveArchive([session()]);
  const archive = await loadArchive();
  const merged = mergeArchive(archive, []); // nothing on disk any more
  assert.equal(merged.length, 1);
  assert.equal(merged[0].activeMs, 1500);
});

test('mergeArchive keeps the fuller view of a session', async () => {
  const archive = emptyArchive();
  archive.bySession.set('claude:s1', session({ turns: 2, activeMs: 1500, endedAt: 5000 }));

  const grown = session({ turns: 5, activeMs: 4000, endedAt: 9000 });
  const merged = mergeArchive(archive, [grown]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].turns, 5);
  assert.equal(merged[0].activeMs, 4000);
});

test('mergeArchive does not regress a session to a thinner parse', () => {
  const archive = emptyArchive();
  archive.bySession.set('claude:s1', session({ turns: 9, activeMs: 9000, endedAt: 9999 }));

  const thin = session({ turns: 1, activeMs: 10, endedAt: 20 });
  const merged = mergeArchive(archive, [thin]);

  assert.equal(merged[0].turns, 9, 'a truncated re-read must not overwrite a fuller record');
});

test('mergeArchive adds sessions it has not seen', () => {
  const archive = emptyArchive();
  archive.bySession.set('claude:s1', session());
  const merged = mergeArchive(archive, [session({ sessionId: 's2', file: '/t/s2.jsonl' })]);
  assert.equal(merged.length, 2);
});

test('two agents sharing a session id stay two sessions', () => {
  // Agents mint ids independently. A bare-id key would silently merge them, and
  // whichever looked "fuller" would erase the other outright.
  const archive = emptyArchive();
  const merged = mergeArchive(archive, [
    session({ agent: 'claude', sessionId: 'same', file: '/t/a.jsonl' }),
    session({ agent: 'codex', sessionId: 'same', file: '/t/b.jsonl' }),
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.agent).sort(), ['claude', 'codex']);
  assert.equal(sessionKey({ agent: 'codex', sessionId: 'same' }), 'codex:same');
});

test('a v1 archive loads as Claude Code and is rewritten as v2', async () => {
  // v1 predates multi-agent support, so every record in it is a Claude session —
  // that is all the tool could read. Dropping them would throw away the history
  // the archive exists to preserve.
  const v1 = JSON.stringify({
    v: 1,
    sessionId: 'legacy',
    cwd: '/repo',
    project: '/repo',
    label: 'repo',
    startedAt: 1000,
    endedAt: 5000,
    turns: 2,
    activeMs: 1500,
    hasTurnData: true,
    prompts: 3,
    spans: [[1000, 2500]],
    file: '/t/legacy.jsonl',
    mtimeMs: 1,
    size: 1,
  });
  await writeFile(archivePath(), `${v1}\n`);

  const archive = await loadArchive();
  const record = archive.bySession.get('claude:legacy');
  assert.ok(record, 'a v1 line must still load');
  assert.equal(record.agent, 'claude');
  assert.equal(record.activeMs, 1500);

  await saveArchive([record]);
  const rewritten = JSON.parse((await readFile(archivePath(), 'utf8')).trim());
  assert.equal(rewritten.v, 2);
  assert.equal(rewritten.agent, 'claude');
});

test('a corrupt line does not lose the rest of the archive', async () => {
  const good = JSON.stringify({
    v: 1,
    sessionId: 'ok',
    cwd: '/r',
    project: '/r',
    label: 'r',
    startedAt: 1,
    endedAt: 2,
    turns: 1,
    activeMs: 1,
    hasTurnData: true,
    prompts: 0,
    spans: [[1, 2]],
    file: '/t/ok.jsonl',
    mtimeMs: 1,
    size: 1,
  });
  await writeFile(archivePath(), `${good}\n{ truncated\n\n${good.replace('"ok"', '"ok2"')}\n`);

  const archive = await loadArchive();
  assert.equal(archive.bySession.size, 2);
});

test('records from a future schema version are ignored', async () => {
  await writeFile(archivePath(), `${JSON.stringify({ v: 99, sessionId: 'future' })}\n`);
  const archive = await loadArchive();
  assert.equal(archive.bySession.size, 0);
});

test('a missing archive is not an error', async () => {
  await rm(archivePath(), { force: true });
  const archive = await loadArchive();
  assert.equal(archive.bySession.size, 0);
});

test('save is atomic and leaves no temp file behind', async () => {
  await saveArchive([session(), session({ sessionId: 's2', file: '/t/s2.jsonl' })]);
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir);
  assert.deepEqual(
    entries.filter((f) => f.includes('tmp')),
    [],
  );
  const text = await readFile(archivePath(), 'utf8');
  assert.equal(text.trim().split('\n').length, 2);
});

// ---------- flags introduced with watch and the archive ----------

test('the archive is on by default and --no-archive turns it off', async () => {
  const { parseArgs } = await import('../dist/cli.js');
  assert.equal(parseArgs([]).options.archive, true);
  assert.equal(parseArgs(['--no-archive']).options.archive, false);
});

test('--interval takes seconds and rejects nonsense', async () => {
  const { parseArgs } = await import('../dist/cli.js');
  assert.equal(parseArgs([]).options.interval, 2);
  assert.equal(parseArgs(['--interval', '5']).options.interval, 5);
  assert.match(parseArgs(['--interval', 'soon']).error ?? '', /number of seconds/i);
  assert.match(parseArgs(['--interval', '0']).error ?? '', /number of seconds/i);
  assert.match(parseArgs(['--interval', '-3']).error ?? '', /number of seconds/i);
});

test('AGENTCLOCK_DIR relocates the archive', async () => {
  assert.ok(archivePath().startsWith(dir), 'archive must follow AGENTCLOCK_DIR');
});

test('cleanup', async () => {
  await rm(dir, { recursive: true, force: true });
});
