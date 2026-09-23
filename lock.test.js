/**
 * `stakeout.lock` — the behavioural lockfile.
 *
 *   node lock.test.js
 *
 * This file is the artefact somebody commits and a reviewer reads in a pull request, which makes
 * two of its properties load-bearing in a way that is easy to lose:
 *
 *   it must be STABLE     an unstable key order turns "three lines changed" into "four hundred
 *                         lines changed", and a reviewer who learns to skim the diff has been
 *                         taught to ignore the one file that exists to be read
 *   it must be HONEST     a package the index has never seen is listed, by name, in the file. A
 *                         lock that silently omitted what it could not resolve would look complete
 *                         and be incomplete, which is the worst state a security artefact can hold
 *
 * The third property is the point of the whole thing: `check` must report DRIFT, UNKNOWN and CLEAN
 * as three different outcomes. A tool that reports "I have never seen this package" as a pass is
 * worse than no tool, because it launders ignorance into assurance.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLock, checkLock, writeLock, readLock, stable, LOCK_VERSION } = require('./lock');
const { Index } = require('./index/schema');

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

/** An index of its own, per test. Nothing here reads the developer's real one. */
function indexWith(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stakeout-index-'));
  const index = new Index({ dir });
  for (const [name, transcript] of entries) index.put(name, transcript);
  index.writeManifest({ revision: 'test-rev' });
  return index;
}

const transcript = (version, over = {}) => ({
  pkg: 'p',
  version,
  strategy: 'nodert',
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  ...over,
});

console.log('stakeout.lock');

/* ── stability ───────────────────────────────────────────────────────────── */

it('two runs over the same facts produce byte-identical files', () => {
  // The single most important property. See the note at the top.
  const index = indexWith([
    ['b', transcript('1.0.0', { env: ['Z', 'A', 'M'] })],
    ['a', transcript('2.0.0', { net: [{ host: 'x.example', port: 443, proto: 'tls' }] })],
  ]);
  const tree = new Map([['b', '1.0.0'], ['a', '2.0.0']]);
  const other = new Map([['a', '2.0.0'], ['b', '1.0.0']]); // same facts, different insertion order

  const one = buildLock(tree, index).lock;
  const two = buildLock(other, index).lock;

  // generatedAt is a timestamp and is expected to differ; everything else must not.
  delete one.generatedAt;
  delete two.generatedAt;
  assert.equal(JSON.stringify(one), JSON.stringify(two), 'the lock is not order-stable');
});

it('array contents are sorted too, not just keys', () => {
  const index = indexWith([['p', transcript('1.0.0', { env: ['ZULU', 'ALPHA', 'MIKE'] })]]);
  const { lock } = buildLock(new Map([['p', '1.0.0']]), index);
  assert.deepEqual(lock.packages['p@1.0.0'].env, ['ALPHA', 'MIKE', 'ZULU']);
});

it('`stable` sorts deeply without disturbing scalars', () => {
  assert.deepEqual(stable({ b: 1, a: [3, 1, 2] }), { a: [1, 2, 3], b: 1 });
  assert.equal(stable('left'), 'left');
  assert.equal(stable(7), 7);
  assert.equal(stable(null), null);
});

/* ── honesty ─────────────────────────────────────────────────────────────── */

it('a package the index has never seen is listed, not omitted', () => {
  const index = indexWith([['known', transcript('1.0.0')]]);
  const tree = new Map([['known', '1.0.0'], ['mystery', '9.9.9']]);
  const { lock, known, unknown } = buildLock(tree, index);

  assert.equal(known, 1);
  assert.deepEqual(unknown, ['mystery@9.9.9']);
  assert.deepEqual(lock.unknown, ['mystery@9.9.9'], 'the FILE must carry it, not just the return value');
  assert.ok(!lock.packages['mystery@9.9.9'], 'an unknown package must not get a fabricated entry');
});

it('a channel the strategy could not watch stays absent, and never becomes []', () => {
  /*
   * The distinction the whole project rests on. `[]` says "we watched and saw nothing"; absent says
   * "we could not watch". Writing the second as the first turns a blind run into a clean bill of
   * health, in a file somebody commits and trusts.
   */
  const blind = transcript('1.0.0', {
    canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: false },
  });
  delete blind.exec; // as transcript/schema.js does for a channel the strategy cannot see

  const index = indexWith([['p', blind]]);
  const { lock } = buildLock(new Map([['p', '1.0.0']]), index);
  const entry = lock.packages['p@1.0.0'];

  assert.ok(!('exec' in entry), 'an unwatchable channel was written as empty');
  assert.deepEqual(entry.net, [], 'a watched-and-empty channel must still be present');
});

it('the lock records which index produced it', () => {
  // Without this, "the answer changed" cannot be told apart from "the index did", six months on.
  const index = indexWith([['p', transcript('1.0.0')]]);
  const { lock } = buildLock(new Map([['p', '1.0.0']]), index);
  assert.equal(lock.index.revision, 'test-rev');
  assert.equal(lock.lockfileVersion, LOCK_VERSION);
});

/* ── checking ────────────────────────────────────────────────────────────── */

it('clean when behaviour matches', () => {
  const index = indexWith([['p', transcript('1.0.0', { env: ['CI'] })]]);
  const tree = new Map([['p', '1.0.0']]);
  const { lock } = buildLock(tree, index);

  const result = checkLock(lock, tree, index);
  assert.equal(result.clean, true);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.drift, []);
});

it('drift when a pinned version starts doing something new', () => {
  // The finding this whole file exists for: the version did not move, the behaviour did.
  const index = indexWith([['p', transcript('1.0.0')]]);
  const tree = new Map([['p', '1.0.0']]);
  const { lock } = buildLock(tree, index);

  // The same version, re-observed, now reading a credential.
  index.put('p', transcript('1.0.0', { env: ['AWS_SECRET_ACCESS_KEY'] }));
  index._cache.clear();

  const result = checkLock(lock, tree, index);
  assert.equal(result.clean, false);
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0].package, 'p@1.0.0');
  const env = result.drift[0].changes.find((c) => c.channel === 'env');
  assert.ok(env, 'the env channel was not reported as changed');
  assert.deepEqual(env.after, ['AWS_SECRET_ACCESS_KEY']);
});

it('unknown is its own outcome and never a pass', () => {
  const index = indexWith([['known', transcript('1.0.0')]]);
  const tree = new Map([['known', '1.0.0']]);
  const { lock } = buildLock(tree, index);

  // A dependency arrives that the index has never observed.
  const bigger = new Map([['known', '1.0.0'], ['new-thing', '0.1.0']]);
  const result = checkLock(lock, bigger, index);

  assert.deepEqual(result.unknown, ['new-thing@0.1.0']);
  assert.equal(result.drift.length, 0, 'an unknown package must not be reported as drift');
  assert.equal(result.clean, true, 'clean describes DRIFT only; unknown is reported separately');
});

it('a dependency added since the lock is not drift', () => {
  // There is no previous behaviour for it to have drifted from. Calling that drift would cry wolf
  // on every ordinary `npm install`, and a tool that cries wolf gets removed from CI.
  const index = indexWith([['a', transcript('1.0.0')], ['b', transcript('2.0.0')]]);
  const { lock } = buildLock(new Map([['a', '1.0.0']]), index);

  const result = checkLock(lock, new Map([['a', '1.0.0'], ['b', '2.0.0']]), index);
  assert.deepEqual(result.added, ['b@2.0.0']);
  assert.equal(result.drift.length, 0);
  assert.equal(result.clean, true);
});

it('a removed dependency is not a finding', () => {
  const index = indexWith([['a', transcript('1.0.0')], ['b', transcript('2.0.0')]]);
  const { lock } = buildLock(new Map([['a', '1.0.0'], ['b', '2.0.0']]), index);

  const result = checkLock(lock, new Map([['a', '1.0.0']]), index);
  assert.equal(result.clean, true);
  assert.equal(result.checked, 1);
});

/* ── the file on disk ────────────────────────────────────────────────────── */

it('a lock round-trips through the filesystem', () => {
  const index = indexWith([['p', transcript('1.0.0', { env: ['CI'] })]]);
  const { lock } = buildLock(new Map([['p', '1.0.0']]), index);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'stakeout.lock');

  writeLock(lock, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), 'no trailing newline — every file a person commits has one');
  assert.ok(text.includes('\n  '), 'the lock is minified; a one-line diff reviews as nothing');
  assert.deepEqual(readLock(file), lock);
});

it('a missing lock is a state, not an error', () => {
  assert.equal(readLock(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())), null);
});

it('a lock from a future format version is refused, loudly', () => {
  // Silently misreading a format we do not know would produce confident wrong answers about
  // software somebody is about to ship.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'stakeout.lock');
  fs.writeFileSync(file, JSON.stringify({ lockfileVersion: LOCK_VERSION + 1, packages: {} }));
  assert.throws(() => readLock(file), /lockfile version/);
});

it('an install script that starts reading a token is drift, even when the import is unchanged', () => {
  const empty = { net: [], dns: [], fs: [], env: [], proc: [{ argv: ['sh', '-c', 'node post.js'] }], exec: [] };
  const was = indexWith([['native', transcript('1.0.0', { install: empty })]]);
  const { lock } = buildLock(new Map([['native', '1.0.0']]), was);
  assert.ok(lock.packages['native@1.0.0'].install, 'the install phase was not pinned');
  const now = indexWith([['native', transcript('1.0.0', { install: { ...empty, env: ['NPM_TOKEN'] } })]]);
  const r = checkLock(lock, new Map([['native', '1.0.0']]), now);
  assert.equal(r.clean, false);
  assert.deepEqual(r.drift[0].changes.map((c) => c.channel), ['install.env']);
});

it('a lock written before the install phase was watched does not read as drift', () => {
  const was = indexWith([['native', transcript('1.0.0')]]);
  const { lock } = buildLock(new Map([['native', '1.0.0']]), was);
  const now = indexWith([['native', transcript('1.0.0', { install: { net: [], dns: [], fs: [], env: ['CI'], proc: [], exec: [] } })]]);
  assert.equal(checkLock(lock, new Map([['native', '1.0.0']]), now).clean, true);
});

console.log(`\n${passed} passed`);
