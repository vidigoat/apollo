#!/usr/bin/env node
/**
 * Where the survey's version pairs come from.
 *
 *   node scripts/pairs.js                 # check every pair in survey.js still exists
 *   node scripts/pairs.js --suggest pkg…  # propose a real adjacent pair for each package named
 *
 * The survey's whole value is that nothing in it was chosen for being interesting. That only holds
 * if the pairs are real, and a hand-typed version number is a guess — `chalk 5.3.0 → 5.4.1` looks
 * plausible whether or not either version was ever published, and a typo becomes a package that
 * silently fails to install and quietly leaves the baseline.
 *
 * So every pair is checked against the registry, and new ones are derived from it rather than
 * recalled. "Adjacent" means adjacent **in publication order**, which is not the same as adjacent in
 * semver: maintainers backport, and 2.1.3 can be published months after 3.0.0. A diff between two
 * versions nobody ever upgraded between is not a baseline, it is a curiosity.
 *
 * Network only. No keys, nothing installed, nothing executed — this reads metadata.
 */

const { PAIRS } = require('./survey');

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', bold: '', off: '' };

const PRERELEASE = /-(alpha|beta|rc|next|canary|dev|experimental|insiders|pre)\b|-\d+$/i;

async function metadata(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`);
  if (!res.ok) throw new Error(`registry says ${res.status} for ${pkg}`);
  return res.json();
}

/**
 * Two versions somebody actually upgraded between.
 *
 * Ordered by publication time, prereleases dropped, and the pair taken from the recent end — a
 * five-year-old bump says less about the registry as it is today. The upgrade must also go FORWARDS
 * in semver, which excludes the backport case where a patch to an old line is published after a new
 * major.
 */
function adjacentPair(meta) {
  const times = meta.time || {};
  const published = Object.keys(meta.versions || {})
    .filter((v) => !PRERELEASE.test(v) && times[v])
    .sort((a, b) => new Date(times[a]) - new Date(times[b]));

  for (let i = published.length - 1; i > 0; i--) {
    const to = published[i];
    const from = published[i - 1];
    /*
     * Forward, and no more than one major apart.
     *
     * Adjacent in publication time is not always adjacent in anybody's lockfile. Maintainers patch
     * old lines, so the release published just before `5.4.2` can be `3.15.2` — forward in semver,
     * and an "upgrade" no human has ever performed in one step. Two majors of accumulated change
     * lands in the diff as a wall of difference that says nothing about the registry's normal
     * behaviour, which is the only thing this survey is measuring.
     */
    if (semverAscending(from, to) && majorGap(from, to) <= 1) return { from, to, when: times[to] };
  }
  return null;
}

const majorOf = (v) => Number(String(v).split('.')[0].replace(/\D.*$/, '')) || 0;
const majorGap = (a, b) => Math.abs(majorOf(b) - majorOf(a));

const semverAscending = (a, b) => {
  const num = (v) => v.split('.').map((n) => Number(n.replace(/\D.*$/, '')) || 0);
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++) {
    if (y[i] > x[i]) return true;
    if (y[i] < x[i]) return false;
  }
  return false;
};

async function verify() {
  console.log(`\n  ${C.bold}Every pair in the survey, against the registry${C.off}`);
  console.log(`  ${C.dim}A version that was never published installs nothing and leaves the baseline quietly.${C.off}\n`);

  let bad = 0;
  for (const [pkg, from, to] of PAIRS) {
    let note = '';
    let ok = true;
    try {
      const meta = await metadata(pkg);
      const have = meta.versions || {};
      const missing = [from, to].filter((v) => !have[v]);
      if (missing.length) { ok = false; note = `not published: ${missing.join(', ')}`; }
      else if (!semverAscending(from, to)) { ok = false; note = 'the upgrade goes backwards'; }
    } catch (e) {
      ok = false;
      note = e.message;
    }
    if (!ok) bad++;
    console.log(`  ${ok ? C.green + 'ok  ' : C.red + 'BAD '}${C.off} ${pkg.padEnd(26)} ${C.dim}${from} → ${to}${C.off} ${C.red}${note}${C.off}`);
  }

  console.log(bad
    ? `\n  ${C.red}${bad} of ${PAIRS.length} pairs do not exist as written.${C.off}\n`
    : `\n  ${C.green}All ${PAIRS.length} pairs are real, published, and upgrade forwards.${C.off}\n`);
  if (bad) process.exitCode = 1;
}

async function suggest(names) {
  const known = new Set(PAIRS.map(([p]) => p));
  const lines = [];

  for (const pkg of names) {
    if (known.has(pkg)) { console.error(`  ${C.dim}skip ${pkg} — already surveyed${C.off}`); continue; }
    try {
      const pair = adjacentPair(await metadata(pkg));
      if (!pair) { console.error(`  ${C.red}skip ${pkg} — no forward-adjacent release pair${C.off}`); continue; }
      lines.push(`  ['${pkg}', '${pair.from}', '${pair.to}'],`);
      console.error(`  ${C.green}ok  ${C.off} ${pkg.padEnd(26)} ${C.dim}${pair.from} → ${pair.to}  ${String(pair.when).slice(0, 10)}${C.off}`);
    } catch (e) {
      console.error(`  ${C.red}skip ${pkg} — ${e.message}${C.off}`);
    }
  }

  // stdout is the paste-able block; everything else went to stderr on purpose.
  console.log(lines.join('\n'));
}

const args = process.argv.slice(2);
if (args[0] === '--suggest') suggest(args.slice(1));
else verify();
