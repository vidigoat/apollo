#!/usr/bin/env node
/**
 * Merge one behavioural index into another.
 *
 *   node scripts/index-merge.js <from-dir> <into-dir>
 *
 * For two builders working different ends of one ranked list (`index-build.js --from N --out …`):
 * each writes its own directory, because two processes writing one would race on the same package
 * file and lose a version, and this folds the second into the first afterwards.
 *
 * Per package, per version: a version the target does not hold is added; one it already holds is
 * kept as it is, unless the incoming observation is newer. It refuses to mix a simulated entry into
 * real observations or the other way round — the same rule `Index.put` enforces, for the same
 * reason: every downstream number reads the index as fact.
 */

const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.json') && !e.name.endsWith('.tmp')) out.push(p);
  }
  return out;
}

function merge(fromDir, intoDir) {
  const fromEntries = path.join(fromDir, 'entries');
  const tally = { packages: 0, added: 0, replaced: 0, kept: 0 };
  for (const file of walk(fromEntries)) {
    const rel = path.relative(fromEntries, file);
    const target = path.join(intoDir, 'entries', rel);
    const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
    const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
    if (!existing) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      tally.packages++;
      tally.added += Object.keys(incoming.versions || {}).length;
      continue;
    }
    const sim = (r) => Object.values(r.versions || {}).some((v) => v.simulated);
    const real = (r) => Object.values(r.versions || {}).some((v) => !v.simulated);
    if ((sim(incoming) && real(existing)) || (real(incoming) && sim(existing))) {
      throw new Error(`${incoming.name}: refusing to mix simulated and real observations`);
    }
    let changed = false;
    for (const [version, entry] of Object.entries(incoming.versions || {})) {
      const have = existing.versions?.[version];
      if (!have) { existing.versions[version] = entry; tally.added++; changed = true; }
      else if (String(entry.observedAt) > String(have.observedAt)) { existing.versions[version] = entry; tally.replaced++; changed = true; }
      else tally.kept++;
    }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
      fs.renameSync(tmp, target);
      tally.packages++;
    }
  }
  return tally;
}

/**
 * Take out versions that were never observed.
 *
 * A re-observation with the fixed builder refuses a version that did not install; the entry it
 * would have replaced is the old, empty "quiet" one, which merge() alone would leave standing. This
 * removes exactly the versions a build log says it refused — `fail  <name@version> Refusing to
 * index …` — and a package whose last version goes is removed whole. Only refusals: a sandbox that
 * errored for its own reasons says nothing about the package.
 */
function refusedIn(log) {
  const out = [];
  for (const line of log.split('\n')) {
    const m = /^\s+fail\s+(\S+)\s+Refusing to index/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!m) continue;
    const at = m[1].lastIndexOf('@');
    if (at > 0) out.push({ name: m[1].slice(0, at), version: m[1].slice(at + 1) });
  }
  return out;
}

function withdraw(intoDir, refused) {
  const { fileFor } = require('../index/schema');
  const tally = { withdrawn: 0, packagesRemoved: 0, absent: 0 };
  for (const { name, version } of refused) {
    const file = fileFor(intoDir, name);
    const rec = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (!rec?.versions?.[version]) { tally.absent++; continue; }
    delete rec.versions[version];
    tally.withdrawn++;
    if (!Object.keys(rec.versions).length) { fs.rmSync(file); tally.packagesRemoved++; continue; }
    rec.updatedAt = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, file);
  }
  return tally;
}

module.exports = { merge, withdraw, refusedIn };

if (require.main === module) {
  const args = process.argv.slice(2);
  const w = args.indexOf('--withdraw');
  const log = w > -1 ? args.splice(w, 2)[1] : null;
  const [from, into] = args;
  if (!from || !into) {
    console.error('usage: node scripts/index-merge.js <from-dir> <into-dir> [--withdraw <build.log>]');
    process.exit(3);
  }
  const t = merge(path.resolve(from), path.resolve(into));
  console.log(`\n  ${t.packages} packages touched · ${t.added} versions added · ${t.replaced} replaced by newer · ${t.kept} already held`);
  if (log) {
    const x = withdraw(path.resolve(into), refusedIn(fs.readFileSync(log, 'utf8')));
    console.log(`  ${x.withdrawn} never-observed versions withdrawn · ${x.packagesRemoved} packages left with none · ${x.absent} were not held`);
  }
  console.log('');
}
