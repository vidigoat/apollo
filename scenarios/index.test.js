/**
 * The engine must never need to know what a scenario family is.
 * Run: node scenarios/index.test.js
 */

const assert = require('node:assert');
const { families, compile, catalogue } = require('./index');

let passed = 0;
const it = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n       ', e.message);
    process.exitCode = 1;
  }
};

console.log('scenario families');

it('every family can describe itself to the scenario writer', () => {
  catalogue().forEach((f) => {
    assert.ok(f.id && f.describe && f.seedsFrom, `${f.id} is missing its description`);
  });
});

it('every family compiles to a setup command and a probe', () => {
  Object.keys(families).forEach((id) => {
    const c = compile({ id: 'T', family: id, params: { pkg: 'x', version: '1', host: 'h', payloadFile: '/tmp/p' } });
    assert.ok(typeof c.setup === 'string' && c.setup.length, `${id} produced no setup`);
    assert.ok(typeof c.probe === 'string' && c.probe.length, `${id} produced no probe`);
  });
});

it('the probe decides the verdict, not the model', () => {
  const c = compile({ id: 'T', family: 'concurrency', params: { n: 8 } });
  assert.match(c.probe, /probe\//, 'a family must assert through a probe script');
});

it('an unknown family is rejected rather than silently skipped', () => {
  assert.throws(() => compile({ family: 'does-not-exist' }), /Unknown scenario family/);
});

console.log(`\n${passed} passed`);
