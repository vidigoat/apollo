/**
 * What the install-phase summary counts — tested on a two-package index.
 *
 *   node scripts/install-summary.test.js
 */
const assert = require('node:assert');
const { summarise } = require('./install-summary');

let passed = 0;
const it = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };

console.log('install-phase summary');

it('counts watched, script-running, networked and credential-reading installs — and only entries that were watched', () => {
  const s = summarise({ packages: {
    a: { versions: { '1.0.0': { install: { proc: [{ argv: ['sh', '-c', 'node x.js'] }], net: [{ host: 'github.com' }, { host: '/tmp/x.sock' }], env: ['GITHUB_TOKEN', 'CI', 'npm_config_loglevel'] } } } },
    b: { versions: { '1.0.0': { env: ['NPM_TOKEN'] } } },
  } });
  assert.equal(s.watchedThroughInstall, 1, 'an entry with no install phase was counted as watched');
  assert.equal(s.ranScript, 1);
  assert.equal(s.reachedNetwork, 1);
  assert.deepEqual(s.topHosts, [['github.com', 1]], 'a local socket path was counted as a host');
  assert.deepEqual(s.credentials, [{ pkg: 'a@1.0.0', reads: ['GITHUB_TOKEN'] }], 'npm settings or import-time reads were counted');
});

console.log(`\n${passed} passed`);
