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

module.exports = { merge };

if (require.main === module) {
  const [from, into] = process.argv.slice(2);
  if (!from || !into) {
    console.error('usage: node scripts/index-merge.js <from-dir> <into-dir>');
    process.exit(3);
  }
  const t = merge(path.resolve(from), path.resolve(into));
  console.log(`\n  ${t.packages} packages touched · ${t.added} versions added · ${t.replaced} replaced by newer · ${t.kept} already held\n`);
}
