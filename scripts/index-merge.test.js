/**
 * Merging two builders' indexes: add what is missing, keep the newer, never mix simulated with real.
 *
 *   node scripts/index-merge.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { merge } = require('./index-merge');

let passed = 0;
const it = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const write = (root, name, versions) => {
  const f = path.join(root, 'entries', '00', `${encodeURIComponent(name)}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name, versions }));
  return f;
};
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, 'entries', '00', `${encodeURIComponent(name)}.json`), 'utf8'));

console.log('index merge');

it('a version the target lacks is added, and a package it lacks is copied whole', () => {
  const a = dir(); const b = dir();
  write(a, 'ms', { '2.1.2': { observedAt: '2026-09-01' } });
  write(b, 'ms', { '2.1.3': { observedAt: '2026-09-23' } });
  write(b, 'once', { '1.4.0': { observedAt: '2026-09-23' } });
  const t = merge(b, a);
  assert.deepEqual(Object.keys(read(a, 'ms').versions).sort(), ['2.1.2', '2.1.3']);
  assert.ok(read(a, 'once').versions['1.4.0']);
  assert.equal(t.added, 2);
});

it('the newer observation of the same version wins; an older one does not replace it', () => {
  const a = dir(); const b = dir();
  write(a, 'ms', { '2.1.3': { observedAt: '2026-09-23', note: 'target' } });
  write(b, 'ms', { '2.1.3': { observedAt: '2026-09-01', note: 'older' } });
  merge(b, a);
  assert.equal(read(a, 'ms').versions['2.1.3'].note, 'target');
  write(b, 'ms', { '2.1.3': { observedAt: '2026-09-30', note: 'newer' } });
  merge(b, a);
  assert.equal(read(a, 'ms').versions['2.1.3'].note, 'newer');
});

it('simulated and real observations are never mixed in one package', () => {
  const a = dir(); const b = dir();
  write(a, 'ms', { '2.1.2': { observedAt: '2026-09-01' } });
  write(b, 'ms', { '2.1.3': { observedAt: '2026-09-23', simulated: true } });
  assert.throws(() => merge(b, a), /refusing to mix/);
});

console.log(`\n${passed} passed`);
