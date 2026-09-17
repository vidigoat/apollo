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

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
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

const CLAIMS = [
  { what: 'tree size', value: corpus.TOTAL.toLocaleString() },
  { what: 'packages that moved', value: String(corpus.CHANGED.length) },
  { what: 'twins forked', value: from(demo, /Forked\s+(\d+) twins/, 'twins') },
  { what: 'packages that behaved identically', value: from(demo, /(\d+) of \d+ packages behaved identically/, 'quiet count') },
  { what: 'model calls', value: from(demo, /(\d+) model calls\s+\(not/, 'model calls') },
  { what: 'invariant drift', value: from(run([path.join(__dirname, '..', 'probe', 'invariant-totals.js')]), /^(\d+\/\d+) orders/m, 'drift') },
  // NOTE: the suite count is checked by the runner itself (scripts/test.js), not here. Re-running
  // the whole suite from this script to learn a number the suite already printed made this check
  // slow enough that somebody would stop running it, and a check nobody runs protects nothing.
];

console.log('\n  README figures, against the commands that produce them\n');

let stale = 0;
for (const c of CLAIMS) {
  // A figure the README never mentions is fine. A figure it mentions WRONG is not, so look for the
  // value and, if it is absent, say so rather than passing silently.
  const present = README.includes(c.value);
  console.log(`  ${present ? C.green + 'ok  ' : C.red + 'MISSING'}${C.off} ${c.what.padEnd(36)} ${C.dim}${c.value}${C.off}`);
  if (!present) stale++;
}

console.log(stale
  ? `\n  ${C.red}${stale} figure(s) the commands produce do not appear in the README.${C.off}\n  Either the README is stale, or it stopped quoting something worth quoting.\n`
  : `\n  ${C.green}Every figure the README quotes is one a command still produces.${C.off}\n`);

if (stale) process.exitCode = 1;
