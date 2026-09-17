#!/usr/bin/env node
/**
 * Run every suite, then report.
 *
 * Deliberately not `a && b && c`: that stops at the first failure and quietly reports a smaller
 * number of checks than the project actually has, which reads like success.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'eval']);

function suites(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) suites(full, found);
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found;
}

const files = suites(ROOT).sort();
let checks = 0;
const failed = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  let out = '';
  try {
    out = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    failed.push(rel);
  }
  process.stdout.write(out);
  const m = out.match(/(\d+) passed/);
  if (m) checks += Number(m[1]);
}

const tally = `${files.length} suites · ${checks} checks`;

console.log('\n' + '─'.repeat(60));
console.log(tally);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('all green');

/*
 * The README quotes this line. Twice now it has gone stale there — once by one check, once by six
 * whole suites — which is two more times than a rule written in prose was ever going to survive.
 *
 * It is checked here rather than in `check-readme` because here the number is already in hand. The
 * alternative was for that script to run the entire suite a second time in order to learn something
 * the suite had just printed, which made it slow enough that somebody would stop running it, and a
 * check nobody runs protects nothing.
 *
 * Only after 'all green': a failing run reports fewer checks than the project has, and failing over
 * a stale README on top of a real failure buries the thing that actually matters.
 */
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
if (!readme.includes(tally)) {
  const quoted = /^\d+ suites · \d+ checks$/m.exec(readme);
  console.log(
    `\nREADME is stale: it says "${quoted ? quoted[0] : 'nothing'}" and this run was "${tally}".\n` +
    `  Fix the line in README.md under "## Tests". Nothing else is wrong.`
  );
  process.exit(1);
}
