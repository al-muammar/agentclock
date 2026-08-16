import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseArgs, VERSION } = await import('../dist/cli.js');

const parse = (args) => parseArgs(args);

test('defaults to a 30 day window', () => {
  const { options, error } = parse([]);
  assert.equal(error, undefined);
  assert.equal(options.since, 30 * 86_400_000);
  assert.equal(options.all, false);
});

test('a bare word is the command', () => {
  assert.equal(parse(['now']).options.command, 'now');
  assert.equal(parse(['stats']).options.command, 'stats');
  assert.equal(parse(['pdf']).options.command, 'pdf');
});

test('the one-pager takes the same window and output flags as the dashboard', () => {
  const { options, error } = parse(['pdf', '--since', '7d', '--anonymize', '-o', 'q3.pdf']);
  assert.equal(error, undefined);
  assert.equal(options.command, 'pdf');
  assert.equal(options.since, 7 * 86_400_000);
  assert.equal(options.anonymize, true);
  assert.ok(options.out.endsWith('/q3.pdf'));
});

test('flags may appear before or after the command', () => {
  const a = parse(['--anonymize', 'stats']).options;
  const b = parse(['stats', '--anonymize']).options;
  assert.equal(a.command, 'stats');
  assert.equal(b.command, 'stats');
  assert.equal(a.anonymize, true);
  assert.equal(b.anonymize, true);
});

test('--since accepts both spellings', () => {
  assert.equal(parse(['--since', '7d']).options.since, 7 * 86_400_000);
  assert.equal(parse(['--since=12h']).options.since, 12 * 3_600_000);
});

test('--since rejects a value it cannot parse', () => {
  assert.match(parse(['--since', 'yesterday']).error ?? '', /valid window/i);
  assert.match(parse(['--since=0d']).error ?? '', /valid window/i);
});

test('--since with no value is an error, not a silent default', () => {
  assert.match(parse(['--since']).error ?? '', /needs a window/i);
});

test('both spellings of anonymise are accepted', () => {
  assert.equal(parse(['--anonymize']).options.anonymize, true);
  assert.equal(parse(['--anonymise']).options.anonymize, true);
});

test('--all and --json and --verbose set their flags', () => {
  const { options } = parse(['--all', '--json', '--verbose']);
  assert.equal(options.all, true);
  assert.equal(options.json, true);
  assert.equal(options.verbose, true);
});

test('an unknown option is rejected rather than ignored', () => {
  assert.match(parse(['--nope']).error ?? '', /unknown option/i);
});

test('an unknown option is not mistaken for a command', () => {
  const { error } = parse(['--totally-made-up']);
  assert.ok(error, 'must not fall through to the command slot');
});

test('version is a semver string', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
