import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Claude Code keeps no registry for subagents, so liveness is reconstructed from
 * the transcript each agent writes. Three signals decide it and none is sufficient
 * alone — see src/subagents.ts. This file pins each of them, and the fail-open
 * behaviour that has to survive all of them.
 */

const root = mkdtempSync(path.join(tmpdir(), 'agentclock-subagents-'));
process.env['CLAUDE_CONFIG_DIR'] = root;

const { readLiveSubagents, slugFor, isTerminalRecord, STALE_CAP_MS } = await import(
  '../dist/subagents.js'
);
const { isWorking } = await import('../dist/types.js');

const CWD = '/tmp/proj';
const SESSION = 'ffffffff-1111-2222-3333-444444444444';
const dir = path.join(root, 'projects', slugFor(CWD), SESSION, 'subagents');
mkdirSync(dir, { recursive: true });

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const stamp = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const spawn = (agentId, at) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    agentId,
    type: 'user',
    message: { role: 'user', content: 'do the thing' },
    timestamp: stamp(at),
  });

const assistant = (over) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'thinking' }],
      stop_reason: null,
      ...over.message,
    },
    attributionAgent: over.agentType ?? 'Explore',
    timestamp: stamp(over.at ?? -1000),
  });

/** Write an agent transcript and set its last-write time. */
function agent(agentId, lines, ageMs) {
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const when = (NOW - ageMs) / 1000;
  utimesSync(file, when, when);
}

// Still working: nothing says it stopped.
agent('running', [spawn('running', -600_000), assistant({ at: -30_000 })], 30_000);

// Returned: the assistant answered without asking for another tool.
agent(
  'done',
  [
    spawn('done', -600_000),
    assistant({ message: { stop_reason: 'end_turn' }, agentType: 'general-purpose' }),
  ],
  20_000,
);

// Answered with a tool call still open — that is not the end of the run.
agent(
  'toolcall',
  [
    spawn('toolcall', -600_000),
    assistant({
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', name: 'Bash', input: {} }],
      },
    }),
  ],
  10_000,
);

// Finished, but its transcript never got a terminal record. 43 of 474 real agents
// end this way; only the parent's notification knows they are done.
agent('notified', [spawn('notified', -900_000), assistant({ at: -120_000 })], 120_000);

// Aborted long ago: no terminal record, and none is ever coming.
agent('aborted', [spawn('aborted', -7_200_000), assistant({ at: -3_600_000 })], 45 * 60_000);

// Torn write, mid-append. Must count rather than vanish.
agent('torn', [spawn('torn', -300_000), '{"type":"assistant","message":{"stop_'], 5_000);

// Not an agent transcript at all.
writeFileSync(path.join(dir, 'notes.jsonl'), '{"hello":"world"}\n');

const parent = path.join(root, 'projects', slugFor(CWD), `${SESSION}.jsonl`);
writeFileSync(
  parent,
  `${JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: stamp(-100_000),
    content:
      '<task-notification>\n<task-id>notified</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>',
  })}\n`,
);

const session = { cwd: CWD, sessionId: SESSION };
const agents = await readLiveSubagents(session, NOW);
const byId = new Map(agents.map((a) => [a.agentId, a]));

test('slugFor replaces every non-alphanumeric character', () => {
  assert.equal(slugFor('/Users/me/dev/app'), '-Users-me-dev-app');
  assert.equal(
    slugFor('/Users/me/app/.claude/worktrees/feature-x'),
    '-Users-me-app--claude-worktrees-feature-x',
  );
  // Underscores are not alphanumeric either — this one cost a wrong directory.
  assert.equal(slugFor('/srv/order_pipeline-main'), '-srv-order-pipeline-main');
  assert.equal(slugFor('/tmp/project/'), '-tmp-project');
});

test('isTerminalRecord only accepts an assistant turn that asked for nothing', () => {
  assert.equal(
    isTerminalRecord('{"type":"assistant","message":{"stop_reason":"end_turn","content":[]}}'),
    true,
  );
  assert.equal(
    isTerminalRecord('{"type":"assistant","message":{"stop_reason":null,"content":[]}}'),
    false,
  );
  assert.equal(
    isTerminalRecord(
      '{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"tool_use"}]}}',
    ),
    false,
  );
  assert.equal(isTerminalRecord('{"type":"user","message":{}}'), false);
  // Unrecognised shapes are never terminal: over-reporting is the cheap mistake.
  assert.equal(isTerminalRecord('{"broken'), false);
});

test('every agent transcript is reported, running or not', () => {
  assert.deepEqual(
    [...byId.keys()].sort(),
    ['aborted', 'done', 'notified', 'running', 'toolcall', 'torn'],
    'a file that is not agent-*.jsonl must be ignored, and nothing else dropped',
  );
});

test('an agent with no terminal record and no notification is running', () => {
  assert.equal(byId.get('running')?.running, true);
});

test('a terminal end_turn record ends the run', () => {
  assert.equal(byId.get('done')?.running, false);
});

test('end_turn with an open tool call is not the end of the run', () => {
  assert.equal(byId.get('toolcall')?.running, true);
});

test("the parent's completion notification ends a run with no terminal record", () => {
  assert.equal(byId.get('notified')?.running, false);
});

test('the stale cap stops an aborted agent counting forever', () => {
  assert.equal(byId.get('aborted')?.running, false);
  assert.ok(NOW - byId.get('aborted').lastWriteAt > STALE_CAP_MS);
});

test('a torn write counts as running rather than disappearing', () => {
  assert.equal(byId.get('torn')?.running, true);
});

test('agent type and start time come off the transcript', () => {
  assert.equal(byId.get('running')?.agentType, 'Explore');
  assert.equal(byId.get('done')?.agentType, 'general-purpose');
  assert.equal(byId.get('running')?.startedAt, NOW - 600_000);
  // Only a running agent needs a start time; the second read is not worth it
  // for one that has already returned.
  assert.equal(byId.get('done')?.startedAt, undefined);
});

test('a session with no subagents directory reports none', async () => {
  const none = await readLiveSubagents({ cwd: '/tmp/elsewhere', sessionId: SESSION }, NOW);
  assert.deepEqual(none, []);
});

test('a missing parent transcript leaves candidates running', async () => {
  const other = 'aaaaaaaa-1111-2222-3333-555555555555';
  const otherDir = path.join(root, 'projects', slugFor(CWD), other, 'subagents');
  mkdirSync(otherDir, { recursive: true });
  const file = path.join(otherDir, 'agent-orphan.jsonl');
  writeFileSync(file, `${spawn('orphan', -60_000)}\n${assistant({ at: -5_000 })}\n`);
  const when = (NOW - 5_000) / 1000;
  utimesSync(file, when, when);

  const found = await readLiveSubagents({ cwd: CWD, sessionId: other }, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].running, true, 'no notification means nothing has said it stopped');
});

test('a session counts as working when only a background agent is', () => {
  const idle = { status: 'idle', sessionId: SESSION };
  assert.equal(isWorking(idle, []), false);
  assert.equal(isWorking(idle, agents), true, 'a live agent means the session is working');
  assert.equal(
    isWorking(
      idle,
      agents.filter((a) => !a.running),
    ),
    false,
  );
  assert.equal(isWorking({ status: 'busy', sessionId: SESSION }, []), true);
});

test('cleanup', () => {
  rmSync(root, { recursive: true, force: true });
});
