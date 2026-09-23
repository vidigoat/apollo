/**
 * Cross-validation compares every channel, and a difference on any one of them is a difference.
 *
 *   node scripts/cross-validate.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Index } = require('../index/schema');
const { compare } = require('./cross-validate');

let passed = 0;
const it = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xval-'));
const t = (version, over = {}) => ({ version, strategy: 'nodert', canSee: {}, net: [], dns: [], fs: [], env: [], proc: [], exec: [], ...over });

console.log('cross-validation');

it('identical transcripts count as identical, and where they were observed is tallied', () => {
  const a = dir(); const b = dir();
  new Index({ dir: a }).put('ms', t('2.1.3'));
  new Index({ dir: b }).put('ms', { ...t('2.1.3'), observedOn: 'nebius-token-factory-sandboxes' });
  const r = compare(b, new Index({ dir: a }));
  assert.equal(r.compared, 1);
  assert.equal(r.identical, 1);
  assert.equal(r.observedOn['nebius-token-factory-sandboxes'], 1);
});

it('one environment variable more on one side is a difference, on that channel', () => {
  const a = dir(); const b = dir();
  new Index({ dir: a }).put('picocolors', t('1.1.1', { env: ['NO_COLOR'] }));
  new Index({ dir: b }).put('picocolors', t('1.1.1', { env: ['NO_COLOR', 'CI'] }));
  const r = compare(b, new Index({ dir: a }));
  assert.equal(r.differing, 1);
  assert.deepEqual(Object.keys(r.byChannel), ['env']);
});

it('a version the index has never seen is not counted as agreeing with it', () => {
  const a = dir(); const b = dir();
  new Index({ dir: b }).put('left-pad', t('1.3.0'));
  const r = compare(b, new Index({ dir: a }));
  assert.equal(r.compared, 0);
  assert.equal(r.notInIndex, 1);
});

it('a match is tallied by where each side was made, so same-machine agreement is not cross-machine', () => {
  const a = dir(); const b = dir();
  new Index({ dir: a }).put('ms', t('2.1.3'));
  new Index({ dir: a }).put('kleur', { ...t('4.1.5'), observedOn: 'nebius-token-factory-sandboxes' });
  new Index({ dir: b }).put('ms', { ...t('2.1.3'), observedOn: 'nebius-token-factory-sandboxes' });
  new Index({ dir: b }).put('kleur', { ...t('4.1.5'), observedOn: 'nebius-token-factory-sandboxes' });
  const r = compare(b, new Index({ dir: a }));
  assert.deepEqual(r.pairs['local vs nebius-token-factory-sandboxes'], { identical: 1, differing: 0 });
  assert.deepEqual(r.pairs['nebius-token-factory-sandboxes vs nebius-token-factory-sandboxes'], { identical: 1, differing: 0 });
});

console.log(`\n${passed} passed`);
