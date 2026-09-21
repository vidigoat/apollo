/**
 * Scanning a fleet.
 *
 *   node fleet.test.js
 *
 * One repo answers "is my lockfile pinned". A fleet answers the question somebody who owns thirty
 * of them actually has, and that question is mostly arithmetic — which means the ways it can go
 * wrong are mostly arithmetic too, and quiet.
 *
 * Three of those matter enough to have their own tests:
 *
 *   the ratio must be honest       "N observations answered M questions" is the page's whole claim.
 *                                  Both halves have to come from the same instant, or a growing
 *                                  index silently inflates it. Measured once against a build that
 *                                  was still running, it would have overstated reuse by three
 *                                  quarters.
 *   distinct is not the sum        Counting lodash once per repo that depends on it, and calling
 *                                  the result "distinct packages", would be the single most
 *                                  flattering number available here. It is also a lie.
 *   unknown must not read as clean A repo nobody has ever indexed and a repo that was checked and
 *                                  came back clean are opposite facts. The scan reports `unpinned`
 *                                  for the first, and never `clean`.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Index } = require('./index/schema');
const { scanFleet, scanRepo, findLockfiles } = require('./scripts/fleet-scan');

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

const transcript = (version, over = {}) => ({
  pkg: 'p', version, strategy: 'nodert',
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  ...over,
});

/** A throwaway tree of projects on disk, with a throwaway index that has seen some of them. */
function fixture(projects, observed = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  const index = new Index({ dir: path.join(root, '.index') });

  for (const [name, version] of observed) index.put(name, transcript(version));
  index.writeManifest({ revision: 'test' });

  for (const [dir, deps] of Object.entries(projects)) {
    const at = path.join(root, dir);
    fs.mkdirSync(at, { recursive: true });
    const packages = { '': { name: dir } };
    for (const [name, version] of deps) packages[`node_modules/${name}`] = { name, version };
    fs.writeFileSync(
      path.join(at, 'package-lock.json'),
      JSON.stringify({ name: dir, lockfileVersion: 3, packages })
    );
  }
  return { root, index };
}

console.log('scanning a fleet');

/* ── the numbers ──────────────────────────────────────────────────────────── */

it('a package shared by two projects is counted once as distinct, twice as work avoided', () => {
  /*
   * The entire argument for a central index, and the easiest number in this file to overstate.
   * Four dependency-versions across two projects, three distinct — because lodash is in both.
   */
  const { root, index } = fixture({
    a: [['lodash', '4.17.21'], ['left-pad', '1.3.0']],
    b: [['lodash', '4.17.21'], ['chalk', '5.3.0']],
  });
  const fleet = scanFleet(root, { index });

  assert.equal(fleet.totals.repos, 2);
  assert.equal(fleet.totals.depVersions, 4, 'dependency-versions should count every edge');
  assert.equal(fleet.totals.distinct, 3, 'lodash was counted twice as a distinct package');
});

it('the same package at two versions is two distinct things', () => {
  // A behavioural index answers about a version, not a name. Collapsing on name would claim an
  // observation of 4.17.21 says something about 3.10.1, which is the one thing it cannot do.
  const { root, index } = fixture({
    a: [['lodash', '4.17.21']],
    b: [['lodash', '3.10.1']],
  });
  assert.equal(scanFleet(root, { index }).totals.distinct, 2);
});

it('known counts the questions the index answered, not the packages it holds', () => {
  // One observation of lodash answers two projects' questions about it. That gap IS the leverage,
  // and reporting `known` as 1 here would throw it away.
  const { root, index } = fixture(
    { a: [['lodash', '4.17.21']], b: [['lodash', '4.17.21']] },
    [['lodash', '4.17.21']]
  );
  const fleet = scanFleet(root, { index });
  assert.equal(fleet.totals.known, 2);
  assert.equal(fleet.index.versions, 1, 'the index size at scan time was not recorded');
});

it('the index size travels with the scan, so the ratio is about one instant', () => {
  /*
   * The bug this prevents was live and invisible: a background build grew the index from 266 to
   * 466 versions while a scan sat on disk, and a page reading the denominator fresh would have
   * divided an old numerator by a new one and reported reuse a quarter of its real value. Both
   * halves come from the scan now. Whether the index has moved since is a separate fact, reported
   * separately, and never folded into the arithmetic.
   */
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] }, [['lodash', '4.17.21']]);
  const before = scanFleet(root, { index });

  index.put('chalk', transcript('5.3.0'));
  index.writeManifest({ revision: 'test' });

  assert.equal(before.index.versions, 1, 'the scan mutated after the fact');
  assert.equal(scanFleet(root, { index }).index.versions, 2, 'a later scan did not see the growth');
});

/* ── not knowing ──────────────────────────────────────────────────────────── */

it('a project nobody has indexed is unpinned, never clean', () => {
  // "We have never looked" and "we looked and it was fine" are opposite facts. Every dependency
  // tool on the market prints them the same way; this one must not.
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] });
  const [repo] = scanFleet(root, { index }).repos;
  assert.equal(repo.state, 'unpinned');
  assert.equal(repo.known, 0);
  assert.equal(repo.unknown, 1);
  assert.notEqual(repo.state, 'clean');
});

it('a project with a lock that checks out is clean', () => {
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] }, [['lodash', '4.17.21']]);
  const { buildLock, writeLock } = require('./lock');
  const { parseLockfile } = require('./lockfile');

  const lockfile = path.join(root, 'a', 'package-lock.json');
  const { versions } = parseLockfile(fs.readFileSync(lockfile, 'utf8'));
  writeLock(buildLock(versions, index).lock, path.join(root, 'a', 'stakeout.lock'));

  assert.equal(scanRepo(lockfile, index).state, 'clean');
});

it('behaviour changing under an unmoved version is drift', () => {
  // The whole product, at fleet scale.
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] }, [['lodash', '4.17.21']]);
  const { buildLock, writeLock } = require('./lock');
  const { parseLockfile } = require('./lockfile');

  const lockfile = path.join(root, 'a', 'package-lock.json');
  const { versions } = parseLockfile(fs.readFileSync(lockfile, 'utf8'));
  writeLock(buildLock(versions, index).lock, path.join(root, 'a', 'stakeout.lock'));

  index.put('lodash', transcript('4.17.21', { env: ['AWS_SECRET_ACCESS_KEY'] }));
  index.writeManifest({ revision: 'test' });

  const repo = scanRepo(lockfile, index);
  assert.equal(repo.state, 'drift');
  assert.ok(repo.drift.length, 'drift was reported without saying what drifted');
  assert.equal(repo.drift[0].package, 'lodash@4.17.21');
  assert.deepEqual(repo.drift[0].changes.map((c) => c.channel), ['env'], 'the channel was not named');
  assert.deepEqual(repo.drift[0].changes[0].after, ['AWS_SECRET_ACCESS_KEY'], 'the finding itself was lost');
});

it('an unreadable lock is its own state, not a clean bill of health', () => {
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] });
  fs.writeFileSync(path.join(root, 'a', 'stakeout.lock'), '{ not json');
  assert.equal(scanRepo(path.join(root, 'a', 'package-lock.json'), index).state, 'unreadable-lock');
});

/* ── walking a real disk ──────────────────────────────────────────────────── */

it('node_modules is not a fleet', () => {
  // Every dependency ships its own lockfile sometimes. Counting them would multiply the fleet by a
  // number that means nothing at all.
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] });
  const buried = path.join(root, 'a', 'node_modules', 'lodash');
  fs.mkdirSync(buried, { recursive: true });
  fs.writeFileSync(path.join(buried, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));

  assert.equal(findLockfiles(root).length, 1);
  assert.equal(scanFleet(root, { index }).totals.repos, 1);
});

it('an unreadable project is reported, not dropped', () => {
  // A fleet whose totals quietly exclude what it could not read is a fleet that under-reports
  // exactly the repos most likely to be a problem.
  const { root, index } = fixture({ a: [['lodash', '4.17.21']] });
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'package-lock.json'), '{}');

  const fleet = scanFleet(root, { index });
  assert.equal(fleet.repos.length, 2, 'the broken project vanished');
  assert.ok(fleet.repos.some((r) => r.error), 'nothing was marked as unreadable');
  assert.equal(fleet.totals.repos, 1, 'an unreadable project was counted as scanned');
});

it('an empty tree scans to zero rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-empty-'));
  const fleet = scanFleet(root, { index: new Index({ dir: path.join(root, '.idx') }) });
  assert.equal(fleet.totals.repos, 0);
  assert.equal(fleet.totals.depVersions, 0);
  assert.equal(fleet.totals.distinct, 0);
});

console.log(`\n${passed} passed`);
