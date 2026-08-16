import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const macos = path.join(here, '..', 'macos');
const binary = path.join(macos, 'build', 'AgentClock.app', 'Contents', 'MacOS', 'AgentClock');

/**
 * The menu bar app reimplements readLiveSessions() in Swift, because shelling out
 * to the CLI every two seconds costs ~130x more CPU. That duplication is the price,
 * and this file is what keeps it honest: both implementations read the same fixture
 * directory and must return the same sessions.
 *
 * Skipped anywhere the app cannot be built, which includes the Linux CI legs.
 */
const haveSwift = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
const runnable = process.platform === 'darwin' && haveSwift;

const root = mkdtempSync(path.join(tmpdir(), 'agentclock-menubar-'));
const sessions = path.join(root, 'sessions');
mkdirSync(sessions, { recursive: true });

// This test process is guaranteed alive, so it stands in for a running session.
const LIVE = process.pid;
// macOS caps pids well below this, so it is guaranteed dead.
const DEAD = 4_194_303;

const now = Date.now();
const write = (name, body) =>
  writeFileSync(path.join(sessions, name), typeof body === 'string' ? body : JSON.stringify(body));

const base = (over) => ({
  pid: LIVE,
  sessionId: 'ffffffff-0000-0000-0000-000000000000',
  cwd: '/tmp/project',
  startedAt: now - 60_000,
  status: 'idle',
  kind: 'interactive',
  ...over,
});

write('1.json', base({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'busy' }));
write('2.json', base({ sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'idle' }));
write(
  '3.json',
  base({
    sessionId: 'cccccccc-0000-0000-0000-000000000000',
    status: 'waiting',
    waitingFor: 'permission',
  }),
);
write('4.json', base({ sessionId: 'dddddddd-0000-0000-0000-000000000000', status: 'shell' }));
// An unrecognised status must surface as itself, never be coerced into idle.
write('5.json', base({ sessionId: 'eeeeeeee-0000-0000-0000-000000000000', status: 'sleeping' }));
// Infrastructure, not a coding session.
write('6.json', base({ sessionId: '11111111-0000-0000-0000-000000000000', kind: 'daemon' }));
write('7.json', base({ sessionId: '22222222-0000-0000-0000-000000000000', kind: 'daemon-worker' }));
// Dead process: the registry file outlives the session that wrote it.
write('8.json', base({ sessionId: '33333333-0000-0000-0000-000000000000', pid: DEAD }));
// Torn write, mid-update.
write('9.json', '{"pid":123,"sessionId":"44444');
// Missing the fields that identify a session at all.
write('10.json', { hello: 'world' });
// A worktree session, to exercise project folding on both sides.
write(
  '11.json',
  base({
    sessionId: '55555555-0000-0000-0000-000000000000',
    status: 'busy',
    cwd: '/tmp/repo/.claude/worktrees/feature-x',
  }),
);
// Not a registry entry: Claude Code keeps sibling key files in the same directory.
write('12.abc123.key', 'not json at all');
// Status missing entirely.
write('13.json', { pid: LIVE, sessionId: '66666666-0000-0000-0000-000000000000', cwd: '/tmp/p' });

process.env['CLAUDE_CONFIG_DIR'] = root;
const { readLiveSessions } = await import('../dist/registry.js');

test('menu bar app is built', { skip: !runnable }, () => {
  if (!existsSync(binary)) {
    execFileSync('make', ['-C', macos], { stdio: 'ignore' });
  }
  assert.ok(existsSync(binary), 'expected make to produce the app bundle');
});

test('Swift and TypeScript agree on the live session set', { skip: !runnable }, async () => {
  const out = execFileSync(binary, ['--json'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    encoding: 'utf8',
  });
  const swift = JSON.parse(out);
  const node = await readLiveSessions();

  const key = (s) => `${s.sessionId}|${s.status}|${s.kind}|${s.pid}`;
  const a = [...new Set(swift.map(key))].sort();
  const b = [...new Set(node.map(key))].sort();

  assert.deepEqual(a, b, 'the two implementations disagree about what is running');
});

test('both drop daemons, dead pids and unparseable files', { skip: !runnable }, async () => {
  const node = await readLiveSessions();
  const ids = new Set(node.map((s) => s.sessionId));

  assert.ok(!ids.has('11111111-0000-0000-0000-000000000000'), 'daemon kind must be excluded');
  assert.ok(!ids.has('22222222-0000-0000-0000-000000000000'), 'daemon-worker must be excluded');
  assert.ok(!ids.has('33333333-0000-0000-0000-000000000000'), 'dead pid must be excluded');
  assert.equal(node.length, 7, 'expected the seven well-formed live sessions');
});

test('an unknown status is carried verbatim by both', { skip: !runnable }, async () => {
  const out = execFileSync(binary, ['--json'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    encoding: 'utf8',
  });
  const swift = JSON.parse(out);
  const odd = swift.find((s) => s.sessionId === 'eeeeeeee-0000-0000-0000-000000000000');
  assert.equal(odd?.status, 'sleeping', 'unknown status must not be coerced');

  const missing = swift.find((s) => s.sessionId === '66666666-0000-0000-0000-000000000000');
  assert.equal(missing?.status, 'unknown', 'absent status becomes "unknown", as in registry.ts');
});

test('--count reports the unsmoothed working total', { skip: !runnable }, () => {
  const out = execFileSync(binary, ['--count'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    encoding: 'utf8',
  });
  // busy + shell + busy-in-a-worktree = 3. waiting, idle and the unknown status
  // are all live sessions but none of them is working.
  assert.equal(out.trim(), '3');
});

test('cleanup', () => {
  rmSync(root, { recursive: true, force: true });
});
