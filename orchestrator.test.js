/**
 * The orchestrator is the claim, so it is the thing under test.
 * Run: node orchestrator.test.js
 */

const assert = require('node:assert');
const { runPremortem, writeScenarios, verify } = require('./orchestrator');
const { SimulatedSandboxes } = require('./adapters/simulated');

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
  console.log('orchestrator');

  await it('writes one scenario per twin, spread across the families', () => {
    const s = writeScenarios(200);
    assert.equal(s.length, 200);
    assert.ok(new Set(s.map((x) => x.family)).size >= 8, 'should use every family');
  });

  await it('runs every scenario and accounts for every twin', async () => {
    const r = await runPremortem();
    assert.equal(r.scenariosRun, r.total);
    assert.equal(r.survived + r.failedBranchIndexes.length, r.total);
  });

  await it('files a failure only when it reproduced more than once', async () => {
    const r = await runPremortem();
    r.filed.forEach((f) => assert.ok(f.occurrences >= 2, `${f.id} was filed on ${f.occurrences} occurrence`));
  });

  await it('records a single sighting as unproven instead of filing it', () => {
    assert.equal(verify('F-000', 1).upheld, false);
    assert.equal(verify('F-000', 2).upheld, true);
  });

  await it('files nothing at all against a healthy build', async () => {
    const r = await runPremortem({ adapter: new SimulatedSandboxes({ failing: {} }) });
    assert.equal(r.filed.length, 0);
    assert.equal(r.failedBranchIndexes.length, 0);
    assert.equal(r.survived, r.total);
  });

  await it('releases every branch it forks', async () => {
    const adapter = new SimulatedSandboxes();
    await runPremortem({ adapter });
    assert.equal(adapter.open, 0, 'branches were left open');
  });

  await it('never forks more than the wave cap at once', async () => {
    let peak = 0;
    const adapter = new SimulatedSandboxes();
    const fork = adapter.fork.bind(adapter);
    adapter.fork = async (c, n) => {
      const b = await fork(c, n);
      peak = Math.max(peak, adapter.open);
      return b;
    };
    await runPremortem({ adapter, wave: 50 });
    assert.ok(peak <= 50, `peak concurrency was ${peak}`);
  });

  console.log(`\n${passed} passed`);
})();
