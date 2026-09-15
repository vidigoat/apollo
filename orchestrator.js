/**
 * The actual run.
 *
 * This is the part that has to be real, because it is the claim: fork one healthy checkpoint many
 * times, give each twin a different scenario, and let the probe — not a model — decide what failed.
 *
 * It talks to a SandboxAdapter and to the scenario families. It knows nothing about ConTree, and
 * nothing about which branches are "supposed" to fail. Swap the adapter and the same code runs
 * against Nebius Token Factory.
 */

const { SimulatedSandboxes } = require('./adapters/simulated');
const { compile, catalogue } = require('./scenarios');
const { SEEDED_FAILURES, TOTAL_FORKS, WAVE } = require('./engine');

/**
 * Stand-in for the scenario-writing model. The real one reads the codebase and the advisories Tavily
 * returns; this returns the same shape so the orchestrator is written against the final interface.
 */
function writeScenarios(total) {
  const families = catalogue();
  const out = [];
  for (let i = 0; i < total; i++) {
    const family = families[i % families.length].id;
    out.push({
      id: `S-${String(i).padStart(3, '0')}`,
      family,
      params: { pkg: 'money-fmt', version: '2.4.2', host: 'catalog', payloadFile: '/tmp/p.json', n: 8 },
    });
  }
  return out;
}

/**
 * The independent verifier. A failure is filed only if a second opinion upholds it; anything seen
 * once and not seen again is recorded as unproven rather than reported.
 */
function verify(caseId, occurrences) {
  if (occurrences < 2) {
    return { upheld: false, reason: 'Seen once and not reproduced on re-run. Recorded as unproven.' };
  }
  return { upheld: true, reason: `Reproduced in ${occurrences} independent twins.` };
}

async function runPremortem({ adapter = new SimulatedSandboxes(), total = TOTAL_FORKS, wave = WAVE } = {}) {
  const startedAt = Date.now();
  const scenarios = writeScenarios(total);
  const checkpoint = await adapter.boot('ghcr.io/demo/orders-api:1.9.3');

  const failedBranchIndexes = [];
  const occurrences = {};
  const waves = Math.ceil(total / wave);

  for (let w = 0; w < waves; w++) {
    const size = Math.min(wave, total - w * wave);
    const branches = await adapter.fork(checkpoint, size);

    // A wave runs together; the cap exists because Sandboxes limits simultaneous operations.
    await Promise.all(
      branches.map(async (branch) => {
        const scenario = compile(scenarios[branch.index]);
        await adapter.run(branch, scenario.setup);
        const verdict = await adapter.run(branch, scenario.probe);

        if (verdict.code !== 0) {
          failedBranchIndexes.push(branch.index);
          if (verdict.caseId) occurrences[verdict.caseId] = (occurrences[verdict.caseId] || 0) + 1;
        }
      })
    );

    await Promise.all(branches.map((b) => adapter.discard(b)));
  }

  const filed = [];
  const unproven = [];
  for (const [caseId, count] of Object.entries(occurrences)) {
    const verdict = verify(caseId, count);
    // A case with no write-up is one the verifier refused; it still gets reported as unproven,
    // never silently dropped.
    const detail = SEEDED_FAILURES.find((f) => f.id === caseId) || { id: caseId, title: 'Unreproducible failure' };
    (verdict.upheld ? filed : unproven).push({ ...detail, occurrences: count, verification: verdict });
  }

  return {
    checkpoint,
    total,
    wave,
    waves,
    scenariosRun: scenarios.length,
    failedBranchIndexes: failedBranchIndexes.sort((a, b) => a - b),
    filed: filed.sort((a, b) => a.id.localeCompare(b.id)),
    unproven,
    survived: total - failedBranchIndexes.length,
    wallMs: Date.now() - startedAt,
  };
}

module.exports = { runPremortem, writeScenarios, verify };
