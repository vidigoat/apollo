/**
 * Reading real lockfiles.
 *
 * This is the file that decides which packages get run, so its failure modes are asymmetric in a
 * way worth being explicit about:
 *
 *   MISSING A PACKAGE     something changed and nobody looked at it. Silent, and the whole point
 *                         of the project not happening.
 *   INVENTING A PACKAGE   a run against a version that does not exist. Noisy, wasteful, obvious.
 *
 * The first is far worse, which is why an unreadable lockfile throws rather than returning an empty
 * tree — an empty tree reads as "nothing to check", and there is no more dangerous answer here.
 *
 * Run: node lockfile.test.js
 */

const assert = require('node:assert');
const { parseLockfile, whatMoved, nameFromPath } = require('./lockfile');

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

/* ── the three formats npm has shipped, all still in the wild ─────────── */

const V3 = JSON.stringify({
  name: 'app', lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/ms': { version: '2.1.3' },
    'node_modules/chalk': { version: '5.3.0' },
    'node_modules/chalk/node_modules/ansi-styles': { version: '6.2.1' },
  },
});

const V2 = JSON.stringify({
  name: 'app', lockfileVersion: 2,
  packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/ms': { version: '2.1.3' },
  },
  dependencies: {
    'left-pad': { version: '1.3.0' },
    ms: { version: '2.1.3' },
  },
});

const V1 = JSON.stringify({
  name: 'app', lockfileVersion: 1,
  dependencies: {
    'left-pad': { version: '1.3.0' },
    chalk: { version: '5.3.0', dependencies: { 'ansi-styles': { version: '6.2.1' } } },
  },
});

console.log('lockfiles');

it('reads all three formats to the same kind of answer', () => {
  const v3 = parseLockfile(V3);
  assert.equal(v3.format, 'v3');
  assert.equal(v3.versions.get('left-pad'), '1.3.0');
  assert.equal(v3.versions.get('ansi-styles'), '6.2.1', 'a nested package is still a package');
  assert.equal(v3.total, 4);

  const v2 = parseLockfile(V2);
  assert.equal(v2.format, 'v2');
  assert.equal(v2.total, 2, 'v2 writes the tree twice; it must not be counted twice');

  const v1 = parseLockfile(V1);
  assert.equal(v1.format, 'v1');
  assert.equal(v1.versions.get('ansi-styles'), '6.2.1', 'v1 nests, and the nesting must be walked');
});

it('the root project is not a dependency of itself', () => {
  assert.equal(parseLockfile(V3).versions.has('app'), false);
});

it('a package path is read to a package name', () => {
  assert.equal(nameFromPath('node_modules/left-pad'), 'left-pad');
  assert.equal(nameFromPath('node_modules/chalk/node_modules/ansi-styles'), 'ansi-styles');
  assert.equal(nameFromPath('node_modules/@scope/thing'), '@scope/thing');
});

it('an unreadable lockfile throws rather than reporting an empty tree', () => {
  // The most dangerous possible answer: "nothing to check".
  assert.throws(() => parseLockfile('{"lockfileVersion":9,"somethingElse":{}}'), /Refusing to report an empty tree/);
  assert.throws(() => parseLockfile('not json'), /not a lockfile/);
  assert.throws(() => parseLockfile('{}'), /Unrecognised lockfile/);
});

it('things that are not releases are left alone', () => {
  // A git URL or a file: path has no version to compare, so a diff between two of them is a diff
  // between two things that are not versions of each other.
  const odd = parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/from-git': { version: 'github:someone/thing#abc123' },
      'node_modules/linked': { version: 'file:../local' },
      'node_modules/real': { version: '2.0.1' },
      'node_modules/prerelease': { version: '3.0.0-beta.2' },
    },
  }));
  assert.deepEqual([...odd.versions.keys()].sort(), ['prerelease', 'real']);
  assert.equal(odd.versions.get('prerelease'), '3.0.0-beta.2', 'a prerelease is still a release');
});

it('the same package at two versions is reported, not silently picked', () => {
  const dupe = parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/semver': { version: '7.5.0' },
      'node_modules/other/node_modules/semver': { version: '6.3.1' },
    },
  }));
  assert.equal(dupe.conflicts.length, 1);
  assert.equal(dupe.conflicts[0].name, 'semver');
  assert.deepEqual(dupe.conflicts[0].versions.sort(), ['6.3.1', '7.5.0']);
});

/* ── what moved ───────────────────────────────────────────────────────── */

const before = parseLockfile(JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/stays': { version: '1.0.0' },
    'node_modules/moves': { version: '2.0.0' },
    'node_modules/goes': { version: '3.0.0' },
  },
}));

const after = parseLockfile(JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/stays': { version: '1.0.0' },
    'node_modules/moves': { version: '2.1.0' },
    'node_modules/arrives': { version: '4.0.0' },
  },
}));

it('only what moved, and the numbers add up', () => {
  const d = whatMoved(before, after);
  assert.deepEqual(d.moved, [{ pkg: 'moves', from: '2.0.0', to: '2.1.0' }]);
  assert.deepEqual(d.added.map((a) => a.pkg), ['arrives']);
  assert.deepEqual(d.removed.map((r) => r.pkg), ['goes']);
  assert.equal(d.unchanged, 1);
  assert.equal(d.moved.length + d.added.length + d.unchanged, d.total);
});

it('an addition is not a change, and is still counted', () => {
  // A new dependency has no "before" to diff against. That is a real limitation, not an oversight,
  // and it is reported rather than folded into the moved list where it would be run against
  // nothing. See the README's "What this cannot do".
  const d = whatMoved(before, after);
  assert.ok(!d.moved.some((m) => m.pkg === 'arrives'));
  assert.equal(d.added.length, 1);
});

it('an unchanged tree produces no work', () => {
  const d = whatMoved(before, before);
  assert.deepEqual(d.moved, []);
  assert.equal(d.unchanged, 3);
});

it('most of a real upgrade does not move, and the shape says so', () => {
  const big = (n, bump) => parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ['', { name: 'app' }],
      ...Array.from({ length: n }, (_, i) => [`node_modules/p${i}`, { version: i < bump ? '1.0.1' : '1.0.0' }]),
    ]),
  }));
  const d = whatMoved(big(500, 0), big(500, 7));
  assert.equal(d.moved.length, 7);
  assert.equal(d.unchanged, 493);
  assert.ok(d.moved.length < d.total * 0.05, 'if most of a tree moves, something is wrong with the reading');
});

/* ── the lockfiles it will actually meet ───────────────────────────────── */

it('a scoped package keeps its scope', () => {
  const g = parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/@babel/core': { version: '7.24.0' },
      'node_modules/@types/node': { version: '20.11.0' },
    },
  }));
  assert.equal(g.versions.get('@babel/core'), '7.24.0');
  assert.equal(g.versions.size, 2, 'a scope is part of the name, not a directory to walk past');
});

it('an explicit name beats the path it was found at', () => {
  // npm writes aliases this way: installed at one path, actually a different package.
  const g = parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/my-alias': { name: 'real-package', version: '1.2.3' },
    },
  }));
  assert.equal(g.versions.get('real-package'), '1.2.3');
  assert.equal(g.versions.has('my-alias'), false, 'ran the alias instead of the package');
});

it('a node with no version is skipped, not recorded as undefined', () => {
  const g = parseLockfile(JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'app' }, 'node_modules/weird': { link: true }, 'node_modules/fine': { version: '1.0.0' } },
  }));
  assert.deepEqual([...g.versions.keys()], ['fine']);
});

it('a v1 lockfile with no dependencies at all is empty, not unreadable', () => {
  // Distinct from an unrecognised format: this one we understood, and it genuinely has nothing.
  const g = parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
  assert.equal(g.format, 'v1');
  assert.equal(g.total, 0);
});

it('a downgrade is a change like any other', () => {
  // Rolling a dependency back is exactly when you want to know what changed, and it is easy to
  // write a comparison that only notices version numbers going up.
  const a = parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/p': { version: '2.0.0' } } }));
  const b = parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/p': { version: '1.9.0' } } }));
  assert.deepEqual(whatMoved(a, b).moved, [{ pkg: 'p', from: '2.0.0', to: '1.9.0' }]);
});

it('a tree of ten thousand packages is read without complaint', () => {
  const big = JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ['', { name: 'app' }],
      ...Array.from({ length: 10000 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]),
    ]),
  });
  const started = Date.now();
  const g = parseLockfile(big);
  assert.equal(g.total, 10000);
  assert.ok(Date.now() - started < 3000, 'reading a lockfile should not be the slow part of anything');
});

console.log(`\n${passed} passed`);
