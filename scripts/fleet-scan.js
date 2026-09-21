#!/usr/bin/env node
/**
 * Every project on this machine, and how much of each one is actually known.
 *
 *   node scripts/fleet-scan.js ~/code --out local/fleet.json
 *
 * One repo answers "does my lockfile pin behaviour". A fleet answers the question a security lead
 * actually has, which is **which of my thirty repos should I look at first** — and that question
 * has a different shape, because the honest answer is usually "none of them, and here is how much
 * of the tree nobody has ever watched".
 *
 * ── Why this is the surface that matters ────────────────────────────────────
 *
 * The behavioural index is a shared, central thing: a package observed once answers for every repo
 * that depends on it. That property is invisible on one project and obvious across twelve, where
 * the same four hundred packages appear again and again and each is looked at once. This script is
 * how that argument becomes a number rather than a claim.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not install anything, run anything, or touch the network. It reads lockfiles off disk and
 * asks the index what it already knows. A scan of a hundred repos costs whatever it costs to read a
 * hundred JSON files, which is the entire point of having an index at all.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 *
 * The output names directories on somebody's machine, so it is written wherever you point it and
 * `local/` is gitignored. Nothing here is committed and nothing leaves the process.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Index } = require('../index/schema');
const { parseLockfile } = require('../lockfile');
const { buildLock, checkLock } = require('../lock');

const SKIP = new Set(['node_modules', '.git', '.Trash', 'Library', '.npm', '.cache', 'dist', 'build', '.next']);

/** Lockfiles under `root`, without descending into the places that only hold copies of other people's. */
function findLockfiles(root, { depth = 4 } = {}) {
  const found = [];
  const walk = (dir, left) => {
    if (left < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not an error, just not ours
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'package-lock.json') found.push(path.join(dir, e.name));
      else if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), left - 1);
      }
    }
  };
  walk(root, depth);
  return found;
}

/**
 * One repo's standing.
 *
 * `known` / `unknown` are the honest split, and they are reported separately from `drift` because
 * they answer different questions. Drift is "something changed under me". Unknown is "nobody has
 * ever looked", which is the normal state of almost every dependency tree on earth and is not a
 * finding — it is the work.
 */
function scanRepo(lockfilePath, index) {
  const dir = path.dirname(lockfilePath);
  // parseLockfile returns a report; `versions` is the name → version map everything else takes.
  const parsed = parseLockfile(fs.readFileSync(lockfilePath, 'utf8'));
  const tree = parsed.versions;
  const built = buildLock(tree, index);

  // A repo that already keeps a stakeout.lock gets checked against it; one that does not is
  // reported on what the index knows today. Both are useful; only the first can show drift.
  const existing = path.join(dir, 'stakeout.lock');
  let state = 'unpinned';
  let drift = [];
  if (fs.existsSync(existing)) {
    try {
      const result = checkLock(JSON.parse(fs.readFileSync(existing, 'utf8')), tree, index);
      drift = result.drift;
      state = result.drift.length ? 'drift' : 'clean';
    } catch {
      state = 'unreadable-lock';
    }
  }

  return {
    name: path.basename(dir) === path.basename(path.dirname(dir)) ? path.basename(dir)
      : `${path.basename(path.dirname(dir))}/${path.basename(dir)}`,
    dir,
    deps: parsed.total,
    known: built.known,
    unknown: built.unknown.length,
    state,
    /*
     * Carried through in checkLock's own shape rather than flattened. The first version of this
     * invented field names — `pkg`, `channel`, `added` — and every one of them came out undefined,
     * so a drifting project would have rendered a row of blanks and looked like a display bug
     * rather than a finding.
     */
    drift: drift.map((d) => ({ package: d.package, changes: d.changes })),
  };
}

function scanFleet(root, { index = new Index(), depth = 4 } = {}) {
  const repos = [];
  for (const file of findLockfiles(root, { depth })) {
    try {
      repos.push(scanRepo(file, index));
    } catch (e) {
      repos.push({ name: path.basename(path.dirname(file)), dir: path.dirname(file), error: e.message });
    }
  }

  const ok = repos.filter((r) => !r.error);
  /*
   * The number this whole thing exists to produce.
   *
   * Dependency-versions summed across repos counts lodash once per repo that uses it; distinct
   * package-versions counts it once. The gap between them is the leverage of a shared index — the
   * work you do not have to repeat — and quoting the first as if it were the second would be
   * exactly the kind of inflated figure this project keeps writing tests to prevent.
   */
  const distinct = new Set();
  for (const r of ok) {
    try {
      const { versions } = parseLockfile(fs.readFileSync(path.join(r.dir, 'package-lock.json'), 'utf8'));
      for (const [name, version] of versions) distinct.add(`${name}@${version}`);
    } catch { /* counted as a repo error above */ }
  }

  /*
   * What the index held at the moment of the scan.
   *
   * The page's central claim is a ratio — this many observations answered that many questions —
   * and the index grows while a build runs. Reading the denominator live against a numerator
   * counted twenty minutes ago produces a number that is not about anything: measured here, an
   * index that had 266 versions when the scan ran already showed 466 by the time the page loaded,
   * which would have understated reuse by three quarters. Both halves of a ratio have to come from
   * the same instant, so the scan carries its own.
   */
  let indexAtScan = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(index.dir, 'manifest.json'), 'utf8'));
    indexAtScan = { packages: m.packages, versions: m.versions, revision: m.revision };
  } catch { /* no manifest yet: the page states what the scan alone can prove */ }

  return {
    root,
    scannedAt: new Date().toISOString(),
    index: indexAtScan,
    repos: repos.sort((a, b) => (b.deps || 0) - (a.deps || 0)),
    totals: {
      repos: ok.length,
      depVersions: ok.reduce((n, r) => n + r.deps, 0),
      distinct: distinct.size,
      known: ok.reduce((n, r) => n + r.known, 0),
      drifting: ok.filter((r) => r.state === 'drift').length,
      pinned: ok.filter((r) => r.state !== 'unpinned').length,
    },
  };
}

module.exports = { scanFleet, scanRepo, findLockfiles };

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) || process.env.HOME;
  const outFlag = args.indexOf('--out');
  const out = outFlag >= 0 ? args[outFlag + 1] : path.join(__dirname, '..', 'local', 'fleet.json');

  const index = new Index();
  const fleet = scanFleet(root, { index });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fleet, null, 2));

  const t = fleet.totals;
  console.log(`\n  ${t.repos} repos · ${t.depVersions.toLocaleString()} dependency-versions · ${t.distinct.toLocaleString()} distinct`);
  console.log(`  ${t.known.toLocaleString()} answered from the index, ${(t.depVersions - t.known).toLocaleString()} never observed`);
  console.log(`  → ${path.relative(process.cwd(), out)}\n`);
}
