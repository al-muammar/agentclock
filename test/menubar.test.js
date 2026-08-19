import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
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

/**
 * Subagent fixtures for session 1 (`aaaaaaaa…`, busy) and session 2
 * (`bbbbbbbb…`, idle). Between them they cover every branch of the liveness rule:
 * a running agent, one that returned, one that only the parent's notification
 * knows is done, one aborted past the stale cap, and a torn write that must count
 * rather than vanish. Session 2 is the load-bearing one — it is idle, so it only
 * appears in the working count because an agent of its own is still going.
 */
const BUSY_SESSION = 'aaaaaaaa-0000-0000-0000-000000000000';
const IDLE_SESSION = 'bbbbbbbb-0000-0000-0000-000000000000';
const slug = '-tmp-project';

const agentLine = (over = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      stop_reason: null,
      ...over.message,
    },
    attributionAgent: over.agentType ?? 'Explore',
    timestamp: new Date(now - 30_000).toISOString(),
  });

function writeAgent(sessionId, agentId, lines, ageMs) {
  const dir = path.join(root, 'projects', slug, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const when = (now - ageMs) / 1000;
  utimesSync(file, when, when);
}

const spawnLine = (agentId) =>
  JSON.stringify({
    isSidechain: true,
    agentId,
    type: 'user',
    message: { role: 'user', content: 'go' },
    timestamp: new Date(now - 300_000).toISOString(),
  });

writeAgent(BUSY_SESSION, 'live1', [spawnLine('live1'), agentLine()], 20_000);
writeAgent(
  BUSY_SESSION,
  'ended',
  [
    spawnLine('ended'),
    agentLine({ message: { stop_reason: 'end_turn' }, agentType: 'general-purpose' }),
  ],
  25_000,
);
writeAgent(
  BUSY_SESSION,
  'torn',
  [spawnLine('torn'), '{"type":"assistant","message":{"stop_'],
  15_000,
);
writeAgent(BUSY_SESSION, 'gone', [spawnLine('gone'), agentLine()], 45 * 60_000);
// Finished, but its transcript carries no terminal record — only the parent knows.
writeAgent(BUSY_SESSION, 'notified', [spawnLine('notified'), agentLine()], 60_000);
writeFileSync(
  path.join(root, 'projects', slug, `${BUSY_SESSION}.jsonl`),
  `${JSON.stringify({
    type: 'queue-operation',
    timestamp: new Date(now - 55_000).toISOString(),
    content:
      '<task-notification>\n<task-id>notified</task-id>\n<status>completed</status>\n</task-notification>',
  })}\n`,
);

writeAgent(IDLE_SESSION, 'background', [spawnLine('background'), agentLine()], 40_000);

process.env['CLAUDE_CONFIG_DIR'] = root;
const { readLiveSessions } = await import('../dist/registry.js');
const { readLiveSubagentsFor } = await import('../dist/subagents.js');
const { isWorking } = await import('../dist/types.js');

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
  // busy + shell + busy-in-a-worktree = 3, plus the idle session whose background
  // agent is still going. Without that fourth, the badge's agent tally would count
  // work belonging to a session the badge itself says is not working.
  assert.equal(out.trim(), '4');
});

test('the badge names the sessions and the agents inside them', { skip: !runnable }, () => {
  const out = execFileSync(binary, ['--badge'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    encoding: 'utf8',
  });
  // Four working sessions; the busy one has two live agents (live1 and torn) and
  // the idle one has its background agent. The other three transcripts have
  // ended, been notified, or gone stale, and must not appear in the total.
  assert.equal(out.trim(), '◐ 4 (3)');
});

test('Swift and TypeScript agree on which agents are running', { skip: !runnable }, async () => {
  const out = execFileSync(binary, ['--json'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    encoding: 'utf8',
  });
  const swift = JSON.parse(out);

  const sessions = await readLiveSessions();
  const node = await readLiveSubagentsFor(sessions);

  // Compared on identity and verdict, not on timestamps: mtime and the parsed
  // start time are read a few milliseconds apart by the two processes.
  const shape = (list) =>
    [...list]
      .map((a) => `${a.agentId}|${a.running}|${a.agentType ?? ''}`)
      .sort()
      .join(',');

  for (const session of sessions) {
    const theirs = swift.find((s) => s.sessionId === session.sessionId);
    assert.ok(theirs, `Swift lost session ${session.sessionId}`);
    assert.equal(
      shape(theirs.agents ?? []),
      shape(node.get(session.sessionId) ?? []),
      `the two implementations disagree about the agents in ${session.sessionId}`,
    );
  }
});

test('the liveness rule holds on both sides', { skip: !runnable }, async () => {
  const sessions = await readLiveSessions();
  const agents = await readLiveSubagentsFor(sessions);
  const byId = new Map((agents.get(BUSY_SESSION) ?? []).map((a) => [a.agentId, a.running]));

  assert.equal(byId.get('live1'), true, 'no terminal record and no notification: running');
  assert.equal(byId.get('ended'), false, 'a terminal end_turn record ends the run');
  assert.equal(byId.get('notified'), false, "the parent's notification ends the run");
  assert.equal(byId.get('gone'), false, 'past the stale cap, an aborted agent stops counting');
  assert.equal(byId.get('torn'), true, 'a torn write must count rather than vanish');

  const idle = sessions.find((s) => s.sessionId === IDLE_SESSION);
  assert.equal(idle?.status, 'idle');
  assert.equal(
    isWorking(idle, agents.get(IDLE_SESSION) ?? []),
    true,
    'an idle session with a live background agent is working',
  );
});

/**
 * The app is shipped as source and compiled on the user's machine — that is what
 * keeps it clear of Gatekeeper. Shipping a prebuilt binary would silently undo
 * that, and `files: ["macos"]` sweeps in macos/build/ unless it is excluded, so
 * assert on the actual packed file list rather than trusting .gitignore.
 */
test('the npm package ships the menu bar sources but never a built binary', () => {
  const listed = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const files = JSON.parse(listed)[0].files.map((f) => f.path);

  assert.ok(files.includes('macos/AgentClock.swift'), 'the Swift source must ship');
  assert.ok(files.includes('macos/Makefile'), 'the Makefile must ship');
  assert.ok(files.includes('macos/Info.plist'), 'the bundle plist must ship');

  const built = files.filter((f) => f.startsWith('macos/build'));
  assert.deepEqual(built, [], 'macos/build must never be published');
});

/**
 * The bundle carries its own version, which makes four places that must agree —
 * package.json, package-lock.json, src/cli.ts and here. The other three are
 * covered by test/cli.test.js; this closes the gap, because a stale Info.plist
 * ships an app that misreports itself in Finder and nothing else would notice.
 */
test('the app bundle version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const plist = readFileSync(path.join(here, '..', 'macos', 'Info.plist'), 'utf8');

  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
    assert.ok(m, `${key} missing from Info.plist`);
    assert.equal(m[1], pkg.version, `${key} disagrees with package.json`);
  }
});

test('cleanup', () => {
  rmSync(root, { recursive: true, force: true });
});
