/**
 * The behavioural index.
 *
 *   node index/schema.test.js
 *
 * Every other surface is a client of this, so its failure modes are everyone's failure modes. Two
 * of them matter more than the rest:
 *
 *   a miss must be a MISS     `lookup` returning null means "never observed". If a caller could
 *                             mistake that for "observed, did nothing", the index would launder
 *                             ignorance into a clean bill of health for a package nobody ran.
 *   the strategy travels      an entry without its strategy is a claim without a warrant. `nodert`
 *                             seeing nothing and `ebpf` seeing nothing are different facts and the
 *                             index has to keep them apart — permanently, in the file.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Index, entryFor, shardFor, fileFor, CHANNELS, SCHEMA } = require('./schema');

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

const fresh = () => new Index({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'idx-')) });

const transcript = (version, over = {}) => ({
  pkg: 'p',
  version,
  strategy: 'nodert',
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  timing: { installMs: 1234, importMs: 56 },
  result: { installExit: 0, importExit: 0, threw: null },
  ...over,
});

console.log('behavioural index');

it('a cold index answers null, and counts the miss', () => {
  const idx = fresh();
  assert.equal(idx.lookup('nothing', '1.0.0'), null);
  assert.equal(idx.misses, 1);
  assert.equal(idx.has('nothing', '1.0.0'), false);
});

it('what goes in comes out', () => {
  const idx = fresh();
  idx.put('lodash', transcript('4.17.21', { env: ['NODE_ENV'] }));
  const e = idx.lookup('lodash', '4.17.21');
  assert.ok(e);
  assert.deepEqual(e.env, ['NODE_ENV']);
  assert.equal(e.strategy, 'nodert');
  assert.equal(idx.hits, 1);
});

it('the strategy and its blind spots are stored, not just the channels', () => {
  // An entry without these is a claim without a warrant.
  const idx = fresh();
  idx.put('p', transcript('1.0.0', {
    strategy: 'ebpf',
    canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: false },
  }));
  const e = idx.lookup('p', '1.0.0');
  assert.equal(e.strategy, 'ebpf');
  assert.equal(e.canSee.exec, false);
});

it('an unwatchable channel is absent, not empty', () => {
  // transcript/schema.js deletes channels a strategy cannot see; the index must preserve that
  // absence rather than helpfully filling in [].
  const blind = transcript('1.0.0');
  delete blind.exec;
  const idx = fresh();
  idx.put('p', blind);
  const e = idx.lookup('p', '1.0.0');
  assert.ok(!('exec' in e), 'an absent channel was materialised as empty');
  assert.deepEqual(e.net, []);
});

it('volatile fields are dropped', () => {
  // Timings and exit codes differ between two runs of the same thing. Keeping them would make
  // identical behaviour diff as different, which would train people to ignore the diff.
  const idx = fresh();
  idx.put('p', transcript('1.0.0'));
  const e = idx.lookup('p', '1.0.0');
  assert.ok(!('timing' in e), 'timing is not behaviour');
  assert.ok(!('result' in e), 'exit codes are not behaviour');
  assert.ok(e.observedAt, 'when it was observed is worth keeping');
});

it('many versions of one package live in one file', () => {
  // The question a lockfile asks is about one package at two versions; answering from one file
  // rather than two halves the reads.
  const idx = fresh();
  idx.put('p', transcript('1.0.0'));
  idx.put('p', transcript('1.0.1', { env: ['CI'] }));
  idx.put('p', transcript('2.0.0'));

  assert.equal(idx.versions('p').length, 3);
  assert.deepEqual(idx.lookup('p', '1.0.1').env, ['CI']);
  assert.deepEqual(idx.lookup('p', '1.0.0').env, []);
});

it('re-putting a version replaces it rather than duplicating', () => {
  const idx = fresh();
  idx.put('p', transcript('1.0.0', { env: ['OLD'] }));
  idx.put('p', transcript('1.0.0', { env: ['NEW'] }));
  assert.equal(idx.versions('p').length, 1);
  assert.deepEqual(idx.lookup('p', '1.0.0').env, ['NEW']);
});

it('scoped names survive the filesystem', () => {
  // `@scope/name` is not a legal filename anywhere, which is why everything goes through a hash
  // and an encoded basename.
  const idx = fresh();
  idx.put('@babel/core', transcript('7.29.0', { env: ['BABEL_ENV'] }));
  assert.deepEqual(idx.lookup('@babel/core', '7.29.0').env, ['BABEL_ENV']);
  assert.match(shardFor('@babel/core'), /^[0-9a-f]{2}$/);
  assert.ok(!fileFor('/tmp/x', '@babel/core').includes('@babel/core'), 'the raw name reached the path');
});

it('the manifest is counted from the files, not tracked', () => {
  // A counter that drifts from the files is worse than no counter: it is the number a README
  // would quote.
  const idx = fresh();
  idx.put('a', transcript('1.0.0'));
  idx.put('a', transcript('1.0.1'));
  idx.put('b', transcript('2.0.0', { strategy: 'ebpf' }));

  const m = idx.writeManifest({ revision: 'r1' });
  assert.equal(m.packages, 2);
  assert.equal(m.versions, 3);
  assert.deepEqual(m.strategies, ['ebpf', 'nodert']);
  assert.equal(m.revision, 'r1');
});

it('a corrupt entry is a miss, not a crash', () => {
  // A broken index must degrade to "I do not know", which is a supported answer everywhere.
  const idx = fresh();
  idx.put('p', transcript('1.0.0'));
  fs.writeFileSync(fileFor(idx.dir, 'p'), '{ not json');
  idx._cache.clear();
  assert.equal(idx.lookup('p', '1.0.0'), null);
});

it('an entry from an older schema is ignored rather than misread', () => {
  const idx = fresh();
  idx.put('p', transcript('1.0.0'));
  const file = fileFor(idx.dir, 'p');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.schema = SCHEMA - 1;
  fs.writeFileSync(file, JSON.stringify(rec));
  idx._cache.clear();
  assert.equal(idx.lookup('p', '1.0.0'), null);
});

it('entryFor keeps every channel it was given and invents none', () => {
  const e = entryFor(transcript('1.0.0', { net: [{ host: 'a', port: 443, proto: 'tls' }] }));
  for (const c of CHANNELS) assert.ok(Array.isArray(e[c]), `${c} went missing`);
  assert.equal(e.net.length, 1);
});

it('summary says nothing when there is nothing', () => {
  assert.equal(fresh().summary(), 'no index built yet');
});

console.log(`\n${passed} passed`);
