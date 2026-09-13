import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { parseQuota, snapshotFromScopes } = await import('../dist/quota.js');
const { extractToken } = await import('../dist/credentials.js');
const { readBurn, emptyTotals } = await import('../dist/burn.js');

const root = mkdtempSync(path.join(tmpdir(), 'agentclock-usage-'));

/**
 * A trimmed copy of a real /api/oauth/usage response. The shape is Claude Code's
 * own and carries no compatibility promise, which is exactly why it is pinned here
 * rather than trusted at runtime.
 */
const RESPONSE = {
  five_hour: {
    utilization: 3,
    resets_at: '2026-09-13T21:10:00.369485+00:00',
    limit_dollars: null,
  },
  seven_day: { utilization: 2, resets_at: '2026-09-20T07:00:00.369511+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: false, utilization: null },
  limits: [{ kind: 'session', percent: 3 }],
};

test('utilization is read as a percent, not a fraction', () => {
  const snap = parseQuota(RESPONSE, Date.now());
  const five = snap.scopes.find((s) => s.key === 'five_hour');

  // The trap this guards: scaling by 100 turns 3% used into a saturated meter on
  // an almost untouched quota. The response's own limits[] says percent: 3.
  assert.equal(five.used, 3, 'utilization 3 means 3% used');
  assert.equal(five.left, 97, 'so 97% is left');
});

test('null scopes are skipped and unknown ones are carried verbatim', () => {
  const snap = parseQuota(RESPONSE, Date.now());
  const keys = snap.scopes.map((s) => s.key);

  assert.ok(!keys.includes('seven_day_opus'), 'a null scope is not a scope');
  assert.ok(!keys.includes('extra_usage'), 'no utilization number, no scope');
  assert.ok(!keys.includes('limits'), 'the limits array is not a scope');

  // An unrecognised scope must surface as itself rather than vanish — the same
  // rule registry.ts applies to an unknown session status.
  const odd = snap.scopes.find((s) => s.key === 'nimbus_quill');
  assert.ok(odd, 'an unknown scope must still be reported');
  assert.equal(odd.left, 100);
  assert.equal(odd.label, 'nimbus quill', 'no label for it, so its own key is the label');
});

test('known scopes get the labels Claude Code uses', () => {
  const snap = parseQuota(RESPONSE, Date.now());
  assert.equal(snap.scopes.find((s) => s.key === 'five_hour').label, 'session limit');
  assert.equal(snap.scopes.find((s) => s.key === 'seven_day').label, 'weekly limit');
});

test('the binding scope is the one closest to exhaustion', () => {
  const snap = parseQuota(
    { five_hour: { utilization: 10 }, seven_day: { utilization: 80 } },
    Date.now(),
  );
  assert.equal(snap.binding.key, 'seven_day', 'the weekly limit binds first here');
  assert.equal(snap.binding.left, 20);
});

test('reset times are accepted as ISO, epoch seconds or epoch ms', () => {
  const iso = parseQuota({ a: { utilization: 1, resets_at: '2026-09-13T21:10:00Z' } }, 0);
  assert.equal(iso.scopes[0].resetsAt, Date.parse('2026-09-13T21:10:00Z'));

  const secs = parseQuota({ a: { utilization: 1, resets_at: 1789333800 } }, 0);
  assert.equal(secs.scopes[0].resetsAt, 1789333800000, 'seconds are scaled to ms');

  const ms = parseQuota({ a: { utilization: 1, resets_at: 1789333800000 } }, 0);
  assert.equal(ms.scopes[0].resetsAt, 1789333800000, 'milliseconds are left alone');

  const none = parseQuota({ a: { utilization: 1, resets_at: null } }, 0);
  assert.equal(none.scopes[0].resetsAt, undefined, 'no reset time is absent, not zero');
});

test('a response with nothing usable in it is not a snapshot', () => {
  assert.equal(parseQuota({}, 0), null);
  assert.equal(parseQuota(null, 0), null);
  assert.equal(parseQuota('nope', 0), null);
  assert.equal(parseQuota({ five_hour: null, seven_day: null }, 0), null);
  assert.equal(snapshotFromScopes([], 0, false), null);
});

/**
 * The credential blob holds more than one service's secrets. Picking the wrong
 * one would send a third party's bearer token to api.anthropic.com, so the reader
 * asks for the Anthropic credential by name and this is what holds it to that.
 */
test('only the Anthropic credential is ever read from the keychain blob', () => {
  const blob = JSON.stringify({
    // Ordered first on purpose: a "find the first accessToken" walk picks this.
    mcpOAuth: {
      'sentry|800cb29a': { serverName: 'sentry', accessToken: 'SENTRY-TOKEN', expiresAt: 1 },
      'figma|d39d3b62': { serverName: 'figma', accessToken: 'FIGMA-TOKEN' },
    },
    claudeAiOauth: {
      accessToken: 'ANTHROPIC-TOKEN',
      refreshToken: 'refresh',
      expiresAt: 1789340564172,
      subscriptionType: 'max',
    },
  });

  const found = extractToken(blob);
  assert.equal(found.token, 'ANTHROPIC-TOKEN', 'must not pick an MCP server token');
  assert.equal(found.expiresAt, 1789340564172);
});

test('a blob with no Anthropic credential yields nothing', () => {
  const blob = JSON.stringify({ mcpOAuth: { 'sentry|1': { accessToken: 'SENTRY-TOKEN' } } });
  assert.equal(extractToken(blob), null, 'an MCP token is not a fallback');
  assert.equal(extractToken('{}'), null);
  assert.equal(extractToken(''), null);
});

test('a non-JSON keychain value is the token itself', () => {
  // This is the shape `claude setup-token` hands out.
  const found = extractToken('  sk-ant-oat01-abc  ');
  assert.equal(found.token, 'sk-ant-oat01-abc');
  assert.equal(found.expiresAt, undefined);
});

// --- burn ------------------------------------------------------------------

const usageLine = (id, out, extra = {}) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        output_tokens: out,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        ...extra,
      },
    },
  })}\n`;

test('streaming duplicates of one message are counted once', async () => {
  const file = path.join(root, 'dupes.jsonl');
  // Claude Code writes a record per streaming update, so one message appears many
  // times with a growing output_tokens. Summing them all overcounted output by
  // 145% across the author's corpus.
  writeFileSync(file, usageLine('msg_1', 8) + usageLine('msg_1', 120) + usageLine('msg_2', 30));

  const cursor = await readBurn(file);
  assert.equal(cursor.totals.messages, 2, 'two messages, not three records');
  assert.equal(cursor.totals.output, 8 + 30, 'the first record for an id wins');
  assert.equal(cursor.totals.cacheRead, 2000, 'cache reads follow the same dedup');
});

test('a second pass reads only what was appended', async () => {
  const file = path.join(root, 'incremental.jsonl');
  writeFileSync(file, usageLine('a', 10));

  const first = await readBurn(file);
  assert.equal(first.totals.output, 10);
  const offset = first.offset;

  appendFileSync(file, usageLine('b', 25));
  const second = await readBurn(file, first);

  assert.equal(second.totals.output, 35, 'totals accumulate across passes');
  assert.equal(second.totals.messages, 2);
  assert.ok(second.offset > offset, 'the cursor advanced');

  // Nothing new: the totals must not double.
  const third = await readBurn(file, second);
  assert.equal(third.totals.output, 35, 'an unchanged file adds nothing');
});

test('a duplicate straddling the read boundary is still counted once', async () => {
  const file = path.join(root, 'straddle.jsonl');
  writeFileSync(file, usageLine('same', 5));
  const first = await readBurn(file);

  // The same message id, written again after the cursor — a streaming update that
  // landed between two refreshes.
  appendFileSync(file, usageLine('same', 300));
  const second = await readBurn(file, first);

  assert.equal(second.totals.output, 5, 'the id is remembered across passes');
  assert.equal(second.totals.messages, 1);
});

test('a torn final line is skipped without losing the rest', async () => {
  const file = path.join(root, 'torn.jsonl');
  writeFileSync(file, `${usageLine('ok', 40)}{"type":"assistant","message":{"usage":{"outp`);

  const cursor = await readBurn(file);
  assert.equal(cursor.totals.output, 40, 'the complete record still counts');
  assert.equal(cursor.totals.messages, 1);
});

test('a truncated file resets rather than reporting stale totals', async () => {
  const file = path.join(root, 'rotated.jsonl');
  writeFileSync(file, usageLine('x', 10) + usageLine('y', 20));
  const first = await readBurn(file);
  assert.equal(first.totals.output, 30);

  // A new session reusing the path.
  writeFileSync(file, usageLine('z', 7));
  const second = await readBurn(file, first);
  assert.equal(second.totals.output, 7, 'totals start over when the file shrinks');
});

test('a missing file is zero, not a throw', async () => {
  const cursor = await readBurn(path.join(root, 'nope.jsonl'));
  assert.deepEqual(cursor.totals, emptyTotals());
});

test('cleanup', () => {
  rmSync(root, { recursive: true, force: true });
});
