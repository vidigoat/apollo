/**
 * The pair runner.
 *
 * The claim it has to keep: both versions start from the *same* checkpoint, so any difference is
 * attributable to the package rather than to the machine. Everything else here is hygiene —
 * releasing branches, respecting the concurrency cap, not re-running packages that did not move.
 *
 * Run: node runPair.test.js
 */

const assert = require('node:assert');
const { SimulatedSandboxes } = require('./adapters/simulated');
const { runPair, runAll } = require('./runPair');
const { CHANGED } = require('./corpus');

let passed = 0;
const it = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n       ', e.message);
    process.exitCode = 1;
  }
};

(async () => {
  console.log('pair runner');

  await it('both versions start from the same checkpoint', async () => {
    const adapter = new SimulatedSandboxes();
    const checkpoint = await adapter.boot('img');
    const seen = [];
    const fork = adapter.fork.bind(adapter);
    adapter.fork = async (c, n) => {
      seen.push(c);
      return fork(c, n);
    };
    await runPair({ adapter, checkpoint, pkg: 'money-fmt', from: '2.4.1', to: '2.4.2' });
    assert.deepEqual([...new Set(seen)], [checkpoint], 'the two twins must fork from one state');
  });

  await it('gives every machine back, even when a run throws', async () => {
    const adapter = new SimulatedSandboxes();
    const checkpoint = await adapter.boot('img');
    adapter.run = async () => {
      throw new Error('kernel went away');
    };
    await assert.rejects(() => runPair({ adapter, checkpoint, pkg: 'x', from: '1', to: '2' }));
    assert.equal(adapter.open, 0, 'branches were leaked after a failure');
  });

  await it('runs every package whose version moved, and no others', async () => {
    const adapter = new SimulatedSandboxes();
    const r = await runAll({ adapter, changed: CHANGED });
    assert.equal(r.pairsRun, CHANGED.length);
    assert.equal(r.twinsForked, CHANGED.length * 2);
  });

  await it('never exceeds the wave cap', async () => {
    const adapter = new SimulatedSandboxes();
    await runAll({ adapter, changed: CHANGED, wave: 6 }); // 3 packages at a time
    assert.ok(adapter.peakOpen <= 6, `peak concurrency was ${adapter.peakOpen}`);
  });

  await it('releases everything when it finishes', async () => {
    const adapter = new SimulatedSandboxes();
    await runAll({ adapter, changed: CHANGED });
    assert.equal(adapter.open, 0);
  });

  await it('most packages change nothing, and that is the expected shape', async () => {
    const adapter = new SimulatedSandboxes();
    const r = await runAll({ adapter, changed: CHANGED });
    assert.ok(r.quiet > r.changed.length, 'silence should dominate; if it does not, the corpus is wrong');
  });

  await it('finds the planted credential theft', async () => {
    const adapter = new SimulatedSandboxes();
    const r = await runAll({ adapter, changed: CHANGED });
    const caught = r.changed.find((p) => p.pkg === 'express-fileupload');
    assert.ok(caught, 'the planted package was not caught');
    assert.equal(caught.diff.severity, 'alarming');
    assert.ok(caught.diff.env.added.some((e) => /TOKEN|SECRET/.test(e)));
    assert.ok(caught.diff.net.added.length >= 1);
  });

  await it('does not treat a documented new endpoint as an attack', async () => {
    const adapter = new SimulatedSandboxes();
    const r = await runAll({ adapter, changed: CHANGED });
    const hardNegative = r.changed.find((p) => p.pkg === 'node-fetch-retry');
    assert.ok(hardNegative, 'expected to notice the new endpoint');
    assert.notEqual(hardNegative.diff.severity, 'alarming', 'a documented endpoint must not be alarming on behaviour alone');
  });

  await it('reports which observation strategy produced the run', async () => {
    const adapter = new SimulatedSandboxes();
    const r = await runAll({ adapter, changed: CHANGED.slice(0, 2) });
    assert.ok(['ebpf', 'proxy', 'fsdiff'].includes(r.strategy));
    r.results.forEach((p) => assert.equal(p.diff.strategy, r.strategy));
  });

  console.log(`\n${passed} passed`);
})();
