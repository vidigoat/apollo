#!/usr/bin/env node
/**
 * Does the README still say what the commands say?
 *
 *   npm run check-readme
 *
 * Four numbers in this project have gone stale in prose while remaining correct in code: the tree
 * size when a plant was added, the model-call count when that plant reached the judge, the check
 * count twice, and — with some irony — the example inside the rule forbidding exactly this.
 *
 * Every one was found by reading. That is not a process. This is: run the commands, scrape the
 * figures out of their real output, and fail if the README disagrees.
 *
 * Deliberately narrow. It checks the handful of figures a reader would act on, not every digit,
 * because a check that fails on a version string in a code fence is a check somebody deletes.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/*
 * Both documents, not just the README.
 *
 * docs/SUBMISSION.md is the one that gets SUBMITTED, and it quotes the same figures. The sibling
 * project was caught today with two stale numbers in exactly that file — corrected in its README
 * hours earlier and missed in the submission, because nothing was reading it. A stale number in a
 * README is embarrassing; the same number in the document a judge reads, beside a command that
 * disagrees with it, is what this project spends whole test files trying to prevent.
 */
const DOCS = ['README.md', path.join('docs', 'SUBMISSION.md')];
const README = DOCS.map((f) => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  } catch {
    return ''; // a document that does not exist cannot be stale
  }
}).join('\n\n');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Run a command and take its output whatever it exits with.
 *
 * `probe/invariant-totals.js` exits non-zero on purpose — it is reporting a violated invariant, and
 * that is its whole job. Treating a non-zero exit as "no output" would make this checker blind to
 * precisely the command whose number is most worth checking.
 */
const run = (args) => {
  const opts = { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  try {
    return strip(execFileSync(process.execPath, args, opts));
  } catch (e) {
    if (typeof e.stdout === 'string' && e.stdout) return strip(e.stdout);
    throw e;
  }
};

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', off: '' };

const demo = run([path.join(__dirname, 'demo.js')]);
const corpus = require('../corpus');

/** Pull a figure out of real output, so the expectation is never typed twice. */
const from = (text, re, label) => {
  const m = re.exec(text);
  if (!m) throw new Error(`could not find ${label} in the output — this checker is out of date`);
  return m[1];
};

/*
 * `where` makes a claim contextual.
 *
 * Every check here was "does the README contain this string anywhere", which for a small number is
 * close to vacuous: "30" appears in this README inside a duration, a percentage, a port. The sibling
 * repository's identical checker passed for weeks while its README said "all 14 tools" and there
 * were 17 — the claim was checked, the value was right, and `includes('17')` found a 17 somewhere
 * else entirely.
 *
 * A claim with a `where` pattern must match IN CONTEXT, at every occurrence rather than the first,
 * because one corrected sentence beside three stale ones reads as fixed and is not. A README that
 * has stopped mentioning the figure fails too, which is the point: these are the load-bearing
 * numbers, and quietly dropping one is its own kind of drift.
 */
/**
 * The fleet figures.
 *
 * There are two fleets in these documents and they are not interchangeable. The BUNDLED one is
 * `public/fleet-demo.json` — a scan of turborepo, committed, served by the live page, and the one a
 * reader can check. The LOCAL one is a scan of the machine that built this; it is what the ordering
 * experiment in docs/SUBMISSION.md was measured on, it is gitignored, and on a fresh clone there is
 * nothing to check it against, so those claims are only made when the file is there.
 *
 * Each figure gets its own `where`, because a bare `([\d,]+) dependency-versions` now matches both
 * sentences and would demand one number in two places that mean different things.
 */
function fleetClaims() {
  const claims = [];

  const bundled = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'fleet-demo.json'), 'utf8')
  );
  const b = bundled.totals;
  claims.push(
    { what: 'bundled fleet: dependency-versions', value: b.depVersions.toLocaleString(), where: /turborepo: ([\d,]+)\s*\n?dependency-versions/g },
    { what: 'bundled fleet: readable lockfiles', value: String(b.repos), where: /across (\d+) readable lockfiles/g },
    { what: 'bundled fleet: distinct package-versions', value: b.distinct.toLocaleString(), where: /only ([\d,]+) distinct package-versions/g },
    /*
     * The count of lockfiles the reader refused. This is the figure that broke the live page — the
     * site summed the refused rows in with the rest and printed "NaN of NaN — 0%" — so it is now
     * stated in the README and checked here rather than being a number nobody looks at.
     */
    { what: 'bundled fleet: refused lockfiles', value: String(bundled.repos.length - b.repos), where: /\n(\w+) more lockfiles are written/g, spell: true }
  );

  let local;
  try {
    local = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local', 'fleet.json'), 'utf8'));
  } catch {
    return claims;
  }
  const t = local.totals;
  claims.push(
    { what: 'local fleet: dependency-versions', value: t.depVersions.toLocaleString(), where: /projects and ([\d,]+) dependency-versions/g },
    { what: 'local fleet: distinct', value: t.distinct.toLocaleString(), where: /collapsing to ([\d,]+) distinct ones/g },
    { what: 'local fleet: observations', value: local.index.versions.toLocaleString(), where: /([\d,]+) observations in\s*\n?the index/g },
    { what: 'local fleet: answered', value: t.known.toLocaleString(), where: /answered ([\d,]+) of them/g }
  );
  return claims;
}

const CLAIMS = [
  // No `where` here: "N packages" is a phrase this README uses for several different counts — the
  // tree, the ones that moved, the ones in a survey — so matching it in context would be matching
  // the wrong things. A contextual pattern is only an improvement where the phrase means one thing.
  { what: 'tree size', value: corpus.TOTAL.toLocaleString() },
  { what: 'packages that moved', value: String(corpus.CHANGED.length) },
  { what: 'twins forked', value: from(demo, /Forked\s+(\d+) twins/, 'twins'), where: /(\d+) twins\b/g },
  { what: 'packages that behaved identically', value: from(demo, /(\d+) of \d+ packages behaved identically/, 'quiet count') },
  // Likewise: the README quotes "0 model calls" deliberately, for the cached run that costs nothing.
  { what: 'model calls', value: from(demo, /(\d+) model calls\s+\(not/, 'model calls') },
  { what: 'invariant drift', value: from(run([path.join(__dirname, '..', 'probe', 'invariant-totals.js')]), /^(\d+\/\d+) orders/m, 'drift') },
  /*
   * The survey's corpus size, read from the list rather than from a run.
   *
   * The result — "79 of 82 behaved identically" — is reproduced by `npm run survey`, which installs
   * a hundred and sixty-four real packages and is far too slow to belong in a check anybody runs
   * before a commit. But the SIZE is free, it is the half most likely to drift (adding pairs is easy
   * and remembering the README is not), and a README quoting a corpus of forty while the list holds
   * eighty-two is the exact shape of stale number this file exists to catch.
   */
  // No `where`: "N of M behaved identically" appears three times in this README for three different
  // runs — the survey, the demo, and a small worked example — so a contextual capture would match
  // whichever came first. The corpus size is embedded in the value instead, which is unambiguous.
  { what: 'survey corpus', value: `of ${require('./survey').PAIRS.length} behaved identically` },

  /*
   * The fleet figures, counted from the scan rather than from another sentence.
   *
   * These move every time the index grows, and the README quotes them in four places — an
   * observation count, an answered count, a percentage and a reuse ratio, each of which was updated
   * by hand today. One corrected sentence beside three stale ones reads as fixed and is not.
   *
   * Only checked when a scan is on disk: there is deliberately no bundled fleet, so on a fresh
   * clone this has nothing to check against and says so rather than failing.
   */
  ...fleetClaims(),
  // NOTE: the suite count is checked by the runner itself (scripts/test.js), not here. Re-running
  // the whole suite from this script to learn a number the suite already printed made this check
  // slow enough that somebody would stop running it, and a check nobody runs protects nothing.
];

console.log('\n  README figures, against the commands that produce them\n');

/** Small numbers as English, for the claims that are allowed to be written as words. */
const spelled = (n) =>
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
   'eleven', 'twelve'][n] ?? String(n);

let stale = 0;
for (const c of CLAIMS) {
  // A figure the README never mentions is fine. A figure it mentions WRONG is not, so look for the
  // value and, if it is absent, say so rather than passing silently.
  let present;
  let detail = '';

  if (c.where) {
    const found = [...README.matchAll(c.where)].map((m) => m[1]);
    /*
     * A small number at the start of a sentence gets spelled out, and "Four more lockfiles" goes
     * stale exactly as quietly as "4" does — more quietly, because nothing in a diff highlights a
     * word. `spell` accepts either form for the same value, so prose can read like prose and the
     * figure is still pinned to the scan.
     */
    const accepted = c.spell ? [c.value, spelled(Number(c.value))] : [c.value];
    const wrong = found.filter((v) => !accepted.includes(v.toLowerCase()));
    present = found.length > 0 && wrong.length === 0;
    detail = found.length === 0
      ? ' — the README no longer mentions it'
      : wrong.length ? ` — README says ${[...new Set(wrong)].join(', ')}` : '';
  } else {
    present = README.includes(c.value);
  }

  console.log(`  ${present ? C.green + 'ok  ' : C.red + 'STALE  '}${C.off} ${c.what.padEnd(36)} ${C.dim}${c.value}${detail}${C.off}`);
  if (!present) stale++;
}

console.log(stale
  ? `\n  ${C.red}${stale} figure(s) the commands produce do not appear in README.md or docs/SUBMISSION.md.${C.off}\n  Either the README is stale, or it stopped quoting something worth quoting.\n`
  : `\n  ${C.green}Every figure these documents quote is one a command still produces.${C.off}\n`);

if (stale) process.exitCode = 1;
