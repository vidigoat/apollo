/**
 * The behavioural cache.
 *
 * A cache that serves the wrong answer is worse than no cache, and in this project "the wrong
 * answer" has a specific shape: a result produced by a strategy that could not see the thing being
 * asked about. An `fsdiff` run recorded "quiet"; serving that to a `nodert` caller would report a
 * package as calm on the authority of a run that was blind to five of its six channels.
 *
 * So most of this file is about the key rather than the storage.
 *
 * Run: node cache.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BehaviourCache, keyFor, SCHEMA } = require('./cache');

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cache-'));
const JOB = { pkg: 'left-pad', from: '1.2.0', to: '1.3.0', strategy: 'nodert' };
const DIFF = { pkg: 'left-pad', severity: 'none', changed: false, reasons: [] };

console.log('behaviour cache');

it('what goes in comes back out', () => {
  const c = new BehaviourCache({ dir: tmp() });
  assert.equal(c.get(JOB), null, 'an empty cache must miss, not invent');
  c.put(JOB, DIFF);
  assert.deepEqual(c.get(JOB), DIFF);
  assert.equal(c.hits, 1);
  assert.equal(c.misses, 1);
  c.clear();
});

it('the strategy is part of the question, so it is part of the key', () => {
  // The bug this file exists to prevent. An fsdiff run is blind to five of six channels; serving
  // its "quiet" to a nodert caller reports a package as calm on the authority of a blind run.
  const c = new BehaviourCache({ dir: tmp() });
  c.put({ ...JOB, strategy: 'fsdiff' }, { severity: 'none', changed: false });
  assert.equal(c.get({ ...JOB, strategy: 'nodert' }), null,
    'served an fsdiff answer to a nodert question');
  assert.equal(c.get({ ...JOB, strategy: 'ebpf' }), null);
  assert.ok(c.get({ ...JOB, strategy: 'fsdiff' }), 'and still answers the question it was asked');
  c.clear();
});

it('every part of the version pair changes the key', () => {
  const base = keyFor(JOB);
  assert.notEqual(keyFor({ ...JOB, pkg: 'right-pad' }), base);
  assert.notEqual(keyFor({ ...JOB, from: '1.2.1' }), base);
  assert.notEqual(keyFor({ ...JOB, to: '1.3.1' }), base);
  assert.notEqual(keyFor({ ...JOB, strategy: 'ebpf' }), base);
  assert.equal(keyFor({ ...JOB }), base, 'the same question must reach the same answer');
});

it('a direction is not the same as its reverse', () => {
  // Downgrading from 1.3.0 to 1.2.0 is a different diff from upgrading, and a cache that confused
  // them would report the removal of behaviour as its addition.
  assert.notEqual(keyFor(JOB), keyFor({ ...JOB, from: JOB.to, to: JOB.from }));
});

it('a corrupt entry is dropped, not served', () => {
  const dir = tmp();
  const c = new BehaviourCache({ dir });
  c.put(JOB, DIFF);
  const file = c.path(keyFor(JOB));
  fs.writeFileSync(file, '{ this is not json');
  assert.equal(c.get(JOB), null);
  assert.equal(fs.existsSync(file), false, 'a corrupt entry should not be left to fail again');
  c.clear();
});

it('an entry claiming to be something else is refused', () => {
  // Belt and braces against a hash collision or a hand-edited cache. Serving one package's
  // behaviour as another's is the one thing this must never do.
  const dir = tmp();
  const c = new BehaviourCache({ dir });
  const file = c.path(keyFor(JOB));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: SCHEMA, pkg: 'something-else', from: '1.2.0', to: '1.3.0', strategy: 'nodert', diff: DIFF,
  }));
  assert.equal(c.get(JOB), null, 'served an entry that does not describe what was asked for');
  c.clear();
});

it('an entry from an older schema is not reused', () => {
  const dir = tmp();
  const c = new BehaviourCache({ dir });
  const file = c.path(keyFor(JOB));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...JOB, schema: SCHEMA - 1, diff: DIFF }));
  assert.equal(c.get(JOB), null, 'a transcript shape that has changed cannot be compared with an old one');
  c.clear();
});

it('a cache that cannot be written is a slower tool, not a broken one', () => {
  const c = new BehaviourCache({ dir: '/proc/definitely/not/writable' });
  assert.doesNotThrow(() => c.put(JOB, DIFF));
  assert.equal(c.get(JOB), null);
  assert.equal(c.writes, 0);
});

it('it can be turned off entirely', () => {
  const c = new BehaviourCache({ dir: tmp(), enabled: false });
  c.put(JOB, DIFF);
  assert.equal(c.get(JOB), null);
  assert.equal(c.writes, 0, 'a disabled cache must not write either');
});

it('a half-written entry is never visible', () => {
  // put() writes to a temp name and renames, so a reader sees the whole entry or nothing.
  const dir = tmp();
  const c = new BehaviourCache({ dir });
  c.put(JOB, DIFF);
  const shard = path.dirname(c.path(keyFor(JOB)));
  const leftovers = fs.readdirSync(shard).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'a temp file survived the write');
  c.clear();
});

it('it can say everything it knows', () => {
  const c = new BehaviourCache({ dir: tmp() });
  c.put(JOB, DIFF);
  c.put({ pkg: 'ms', from: '2.1.2', to: '2.1.3', strategy: 'nodert' }, { severity: 'minor' });
  const all = c.entries();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.pkg), ['left-pad', 'ms'], 'listed in a stable order');
  assert.ok(all[0].observedAt, 'an answer should say when it was observed');
  c.clear();
});

console.log(`\n${passed} passed`);
