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
  statSync,
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

/**
 * Three agentclock state directories: the badge changes shape depending on whether
 * a quota snapshot exists, and the badge and the HUD follow different scopes, so
 * one fixture is built to make them disagree. Pointing AGENTCLOCK_DIR at a fixture
 * is also what stops these assertions depending on the quota of whoever runs them.
 */
const stateEmpty = path.join(root, 'state-empty');
const stateQuota = path.join(root, 'state-quota');
const stateSplit = path.join(root, 'state-split');
mkdirSync(stateEmpty, { recursive: true });
mkdirSync(stateQuota, { recursive: true });
mkdirSync(stateSplit, { recursive: true });

/** Run the app headless against the fixtures. */
const runApp = (args, state = stateEmpty) =>
  execFileSync(binary, args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root, AGENTCLOCK_DIR: state },
    encoding: 'utf8',
  });

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

/**
 * A quota snapshot exactly as src/usagecache.ts writes it, including an
 * unrecognised scope. The Swift reader must carry that scope through rather than
 * drop it, for the same reason registry.ts carries an unknown session status.
 */
const QUOTA_FIXTURE = {
  v: 1,
  fetchedAt: now - 30_000,
  scopes: [
    { key: 'five_hour', label: 'session limit', used: 58, left: 42, resetsAt: now + 3_600_000 },
    { key: 'seven_day', label: 'weekly limit', used: 12, left: 88, resetsAt: now + 200_000_000 },
    { key: 'nimbus_quill', label: 'nimbus quill', used: 0, left: 100 },
  ],
  sessions: [
    {
      sessionId: BUSY_SESSION,
      input: 4,
      output: 123_456,
      cacheCreation: 900,
      cacheRead: 7_000_000,
      messages: 12,
      subagentOutput: 4_321,
    },
  ],
};
writeFileSync(path.join(stateQuota, 'usage.json'), JSON.stringify(QUOTA_FIXTURE));

/**
 * A snapshot where the binding scope is NOT the five-hour one: the weekly limit is
 * nearly gone while the session window is barely touched. In QUOTA_FIXTURE the two
 * coincide, so only this one can tell the badge's scope from the HUD's.
 */
const SPLIT_FIXTURE = {
  v: 1,
  fetchedAt: now - 30_000,
  scopes: [
    { key: 'five_hour', label: 'session limit', used: 20, left: 80, resetsAt: now + 3_600_000 },
    { key: 'seven_day', label: 'weekly limit', used: 88, left: 12, resetsAt: now + 200_000_000 },
  ],
  sessions: [],
};
writeFileSync(path.join(stateSplit, 'usage.json'), JSON.stringify(SPLIT_FIXTURE));

process.env['CLAUDE_CONFIG_DIR'] = root;
const { readLiveSessions } = await import('../dist/registry.js');
const { readLiveSubagentsFor } = await import('../dist/subagents.js');
const { isWorking } = await import('../dist/types.js');

/**
 * Rebuild whenever the source is newer, not merely when the binary is absent.
 * A binary left over from an older version does not know this version's flags,
 * and an unrecognised flag falls through to `app.run()` — a menu bar app that
 * never exits. Under `node --test` that is an unbounded hang, not a failure.
 */
test('menu bar app is built', { skip: !runnable }, () => {
  const built = existsSync(binary) ? statSync(binary).mtimeMs : 0;
  const newest = ['AgentClock.swift', 'HUD.swift', 'Info.plist', 'Makefile']
    .map((f) => statSync(path.join(macos, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);

  if (built < newest) {
    execFileSync('make', ['-C', macos], { stdio: 'ignore' });
  }
  assert.ok(existsSync(binary), 'expected make to produce the app bundle');
  assert.ok(statSync(binary).mtimeMs >= newest, 'the built app is older than its sources');
});

test('Swift and TypeScript agree on the live session set', { skip: !runnable }, async () => {
  const out = runApp(['--json']);
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
  const out = runApp(['--json']);
  const swift = JSON.parse(out);
  const odd = swift.find((s) => s.sessionId === 'eeeeeeee-0000-0000-0000-000000000000');
  assert.equal(odd?.status, 'sleeping', 'unknown status must not be coerced');

  const missing = swift.find((s) => s.sessionId === '66666666-0000-0000-0000-000000000000');
  assert.equal(missing?.status, 'unknown', 'absent status becomes "unknown", as in registry.ts');
});

test('--count reports the unsmoothed working total', { skip: !runnable }, () => {
  const out = runApp(['--count']);
  // busy + shell + busy-in-a-worktree = 3, plus the idle session whose background
  // agent is still going. Without that fourth, the badge's agent tally would count
  // work belonging to a session the badge itself says is not working.
  assert.equal(out.trim(), '4');
});

test('the badge names the sessions and the agents inside them', { skip: !runnable }, () => {
  const out = runApp(['--badge']);
  // Four working sessions; the busy one has two live agents (live1 and torn) and
  // the idle one has its background agent. The other three transcripts have
  // ended, been notified, or gone stale, and must not appear in the total.
  //
  // Run against the state directory with no quota snapshot, so this is also the
  // guarantee that the badge is byte-for-byte what it was before quota existed.
  assert.equal(out.trim(), '◐ 4 (3)');
});

test('the badge appends the binding limit when a snapshot exists', { skip: !runnable }, () => {
  // 42% is the five_hour scope — the lowest of the three, so the one that decides
  // when work stops. Not the first in the file, and not the weekly headline.
  assert.equal(runApp(['--badge'], stateQuota).trim(), '◐ 4 (3) · 42%');
});

/**
 * The HUD draws its pill rather than typesetting it, so --hud renders the same
 * state as a string. The point of asserting on it is not the glyphs: it is that
 * two renderers of one Snapshot cannot drift apart in what they think is working.
 */
test('the HUD pill and the badge count the same sessions', { skip: !runnable }, () => {
  const hud = runApp(['--hud'], stateQuota).trim();
  const working = Number(runApp(['--count']).trim());

  const dots = (hud.match(/[●◐]/g) ?? []).length;
  assert.equal(dots, working, 'one dot per working session, same four the badge counts');
  assert.ok(
    runApp(['--badge'], stateQuota).trim().startsWith(`◐ ${working}`),
    'the badge leads with the same total',
  );
  // In this fixture the five-hour scope is also the binding one, so both renderers
  // land on 42%. What that costs them apart is the next test.
  assert.ok(hud.endsWith('42%'), 'the pill ends on the session limit');
});

/**
 * The badge and the tab deliberately follow different scopes, and this is the only
 * fixture that can tell them apart.
 *
 * The badge is one line with no room to say which limit it means, so it takes the
 * one closest to exhaustion. The tab is read all day, and the weekly limit barely
 * moves across a working day — following the minimum would pin it to a number that
 * says nothing about whether you can keep going this afternoon.
 */
test('the badge follows the binding limit, the tab follows the session one', {
  skip: !runnable,
}, () => {
  assert.equal(
    runApp(['--badge'], stateSplit).trim(),
    '◐ 4 (3) · 12%',
    'the badge takes the weekly limit, because it is the one about to bite',
  );
  assert.ok(
    runApp(['--hud'], stateSplit).trim().endsWith('80%'),
    'the tab takes the five-hour window, not the minimum',
  );
});

test('the HUD pill shows no quota it does not have', { skip: !runnable }, () => {
  // stateEmpty has no usage.json at all, which is every install before the first
  // `agentclock usage`. A pill that invented a percentage there would be the worst
  // kind of wrong, because it would look right.
  assert.ok(!runApp(['--hud']).includes('%'), 'no snapshot, no percentage');
});

test('Swift reads the quota snapshot the way TypeScript wrote it', { skip: !runnable }, () => {
  const swift = JSON.parse(runApp(['--usage'], stateQuota));

  assert.equal(swift.binding, 'five_hour', 'the binding scope is the closest to exhaustion');
  assert.deepEqual(
    swift.scopes.map((s) => [s.key, s.left]),
    QUOTA_FIXTURE.scopes.map((s) => [s.key, s.left]),
    'every scope survives the round trip, in order',
  );
  assert.equal(
    swift.scopes.find((s) => s.key === 'nimbus_quill').label,
    'nimbus quill',
    'an unrecognised scope is carried, not dropped',
  );
  assert.equal(swift.fetchedAt, QUOTA_FIXTURE.fetchedAt);

  const burn = swift.sessions.find((s) => s.sessionId === BUSY_SESSION);
  assert.equal(burn.output, 123_456, 'per-session burn round-trips');
  assert.equal(burn.cacheRead, 7_000_000);
});

test('a malformed snapshot leaves the badge intact', { skip: !runnable }, () => {
  const broken = path.join(root, 'state-broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, 'usage.json'), '{"v":1,"scopes":[{"key":');

  // Failing open matters more here than anywhere: a corrupt cache must cost the
  // percentage, never the session count.
  assert.equal(runApp(['--badge'], broken).trim(), '◐ 4 (3)');
  assert.deepEqual(JSON.parse(runApp(['--usage'], broken)).sessions, []);
});

test('a snapshot from a future schema version is ignored', { skip: !runnable }, () => {
  const future = path.join(root, 'state-future');
  mkdirSync(future, { recursive: true });
  writeFileSync(path.join(future, 'usage.json'), JSON.stringify({ ...QUOTA_FIXTURE, v: 2 }));
  assert.equal(runApp(['--badge'], future).trim(), '◐ 4 (3)', 'v2 is not read as v1');
});

test('Swift and TypeScript agree on which agents are running', { skip: !runnable }, async () => {
  const out = runApp(['--json']);
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
  assert.ok(
    files.includes('macos/HUD.swift'),
    'the HUD source must ship too, or it will not build',
  );
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
