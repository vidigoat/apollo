/**
 * The published evidence is exactly what the reports say, today.
 *
 *   node scripts/evidence.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { evidence } = require('./evidence');

let passed = 0;
const it = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };

console.log('evidence');

it('public/evidence.json is what the reports compute — rerun `node scripts/evidence.js` if not', () => {
  const published = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'evidence.json'), 'utf8'));
  assert.deepEqual(published, evidence());
});

it('every item names the report it came from, and that report exists', () => {
  for (const item of evidence().items) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', item.source)), `${item.source} is missing`);
    assert.match(item.measured, /^\d{4}-\d{2}-\d{2}$/);
  }
});

console.log(`\n${passed} passed`);
