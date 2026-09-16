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

console.log('\n' + '─'.repeat(60));
console.log(`${files.length} suites · ${checks} checks`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('all green');
