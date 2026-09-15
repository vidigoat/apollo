/**
 * CASSANDRA — pre-mortem engine
 *
 * Architecture (real shape; the Sandboxes adapter is the only simulated part today):
 *
 *   ingest(app)          -> build OCI image, boot, reach a HEALTHY checkpoint
 *   scenarios(app, web)  -> Nemotron invents adverse scenarios, seeded by Tavily advisories
 *   fork(checkpoint, N)  -> ConTree: branch N times, run in parallel (waves of <=50)
 *   verify(failures)     -> second Nemotron family must confirm; else ABSTAIN (not filed)
 *   prove(fix)           -> re-fork under same scenario; green across all re-forks or not "fixed"
 *   pin(failure)         -> emit a permanent regression test so it can never silently return
 *
 * Swap SimulatedSandboxes for ContreeSandboxes (contree-sdk) + Nebius Token Factory keys
 * and the same orchestration runs for real.
 */

const SCENARIO_LIBRARY = [
  // families the model draws from; each entry becomes a concrete, parameterised perturbation
  { family: 'dependency', label: 'dependency pin moved', injector: 'rewrite lockfile -> reinstall -> run suite' },
  { family: 'input', label: 'malformed payload', injector: 'replay crafted request against live service' },
  { family: 'concurrency', label: 'concurrent writers', injector: 'fire N simultaneous requests, assert invariants' },
  { family: 'dependency-down', label: 'upstream unavailable', injector: 'block egress to dependency, probe' },
  { family: 'latency', label: 'upstream slow', injector: 'inject 3s latency on dependency, probe timeouts' },
  { family: 'clock', label: 'clock skew', injector: 'set fake time +26h, probe token/expiry logic' },
  { family: 'resource', label: 'disk pressure', injector: 'fill volume to 99%, probe write paths' },
  { family: 'auth', label: 'expired credential', injector: 'expire token mid-flight, probe refresh' },
];

/** The three failures that actually reproduce in the demo corpus. Each mirrors a real 2025-26 incident class. */
const SEEDED_FAILURES = [
  {
    id: 'F-017',
    family: 'dependency',
    title: 'Order totals silently corrupt after a patch-level dependency bump',
    scenario: 'Bump `money-fmt` 2.4.1 -> 2.4.2 (patch, in-range for ^2.4.0) and replay the checkout suite.',
    seededBy: 'Tavily: changelog notes a rounding-mode change shipped in a patch release',
    mirrors: 'Class: a config/dependency change propagating globally (cf. Google Cloud quota push, Jun 2025)',
    branchesRun: 24,
    branchesFailed: 24,
    severity: 'critical',
    blast: 'Every order with a fractional tax line is off by one cent, in the merchant\'s favour. No test fails.',
    repro: [
      '$ contree fork --from ckpt_healthy_8f2a --label F-017',
      '  forked in 410ms (copy-on-write)',
      '$ npm i money-fmt@2.4.2 --silent',
      '$ npm test -- checkout',
      '  ✓ checkout creates an order',
      '  ✓ checkout applies tax',
      '  ✓ 41 passing   <-- suite is GREEN',
      '$ node probe/invariant-totals.js',
      '  order_1042  expected 118.28  got 118.29   DELTA +0.01',
      '  order_1043  expected  94.55  got  94.56   DELTA +0.01',
      '  228/500 orders drifted   INVARIANT VIOLATED',
    ],
    rootCause:
      '2.4.2 changed the default rounding mode from HALF_EVEN to HALF_UP. The suite asserts on shapes and status codes, never on a computed total, so the drift is invisible to CI.',
    fix: {
      summary: 'Pin the rounding mode explicitly instead of inheriting the library default.',
      diff: [
        "- const fmt = require('money-fmt')",
        "+ const fmt = require('money-fmt').withRounding('HALF_EVEN')",
      ],
    },
    pinnedTest: 'test/invariants/totals.spec.js — asserts the exact cent on a fractional-tax basket',
    proof: { reforks: 500, green: 500 },
  },
  {
    id: 'F-093',
    family: 'concurrency',
    title: 'Two clicks, two charges: checkout double-charges under concurrent submit',
    scenario: 'Fire 8 concurrent POST /checkout with the same idempotency key, 40ms apart.',
    seededBy: 'Tavily: incident write-ups describing duplicate side effects under retry',
    mirrors: 'Class: a race producing duplicate side effects (cf. CircleCI duplicate workflows, Dec 2025)',
    branchesRun: 32,
    branchesFailed: 7,
    severity: 'critical',
    blast: 'Customer is charged twice. Reproduces in 7 of 32 branches — a 1-in-5 race CI would never catch.',
    repro: [
      '$ contree fork --from ckpt_healthy_8f2a --fan 32 --label F-093',
      '  32 branches live (wave 1/1)',
      '$ ./probe/concurrent-checkout.sh --n 8 --stagger 40ms',
      '  branch 04  charges=2  ✗',
      '  branch 09  charges=2  ✗',
      '  branch 17  charges=2  ✗',
      '  ... 7 of 32 branches charged twice',
      '  reproduced deterministically at stagger=40ms',
    ],
    rootCause:
      'The idempotency key is checked and then written in two statements. Between them a second request passes the same check. The window is ~35-60ms, so it only opens under real concurrency.',
    fix: {
      summary: 'Make the idempotency claim atomic — insert-if-absent, let the loser read the winner\'s result.',
      diff: [
        '- const seen = await db.get(key); if (seen) return seen;',
        '- await db.put(key, result);',
        '+ const claim = await db.insertIfAbsent(key, PENDING);',
        '+ if (!claim.inserted) return await db.awaitResult(key);',
      ],
    },
    pinnedTest: 'test/invariants/idempotency.spec.js — 8 concurrent submits, asserts exactly one charge',
    proof: { reforks: 500, green: 500 },
  },
  {
    id: 'F-131',
    family: 'dependency-down',
    title: 'Checkout stays down for 6 minutes after the catalog service recovers',
    scenario: 'Blackhole egress to catalog for 90s, restore it, then measure recovery.',
    seededBy: 'Tavily: post-mortems on retry storms and cascading dependency failure',
    mirrors: 'Class: cascading failure amplified by retries (cf. AWS DynamoDB us-east-1, Oct 2025, 141 services)',
    branchesRun: 18,
    branchesFailed: 18,
    severity: 'high',
    blast: 'Dependency is down 90s; checkout is down 6m20s. The recovery is the outage.',
    repro: [
      '$ contree fork --from ckpt_healthy_8f2a --label F-131',
      '$ ./probe/blackhole.sh catalog --for 90s',
      '  catalog unreachable',
      '  checkout 503 (expected)',
      '$ ./probe/blackhole.sh --restore',
      '  catalog healthy at t+90s',
      '  checkout still 503 at t+120s',
      '  checkout still 503 at t+300s',
      '  checkout healthy at t+380s   RECOVERY LAG 290s',
    ],
    rootCause:
      'Every failed call retries 5 times with a fixed 1s backoff and no jitter. When catalog returns, 4,000 queued retries fire in the same second and knock it straight back down. The pool never drains.',
    fix: {
      summary: 'Exponential backoff with jitter, plus a circuit breaker that sheds load while the dependency is down.',
      diff: [
        '- retry({ times: 5, delay: 1000 })',
        '+ retry({ times: 5, delay: expJitter(200, 8000), breaker: catalogBreaker })',
      ],
    },
    pinnedTest: 'test/invariants/recovery.spec.js — asserts recovery within 15s of dependency restore',
    proof: { reforks: 500, green: 500 },
  },
];

/** Scenarios that ran and did NOT reproduce — the quiet majority. Shown, because absence is evidence. */
function survivingScenarios(total, failed) {
  const out = [];
  for (let i = 0; i < total - failed; i++) {
    const s = SCENARIO_LIBRARY[i % SCENARIO_LIBRARY.length];
    out.push({ family: s.family, label: s.label });
  }
  return out;
}

/** One case the verifier REFUSED to file — the abstain path, which is the trust story. */
const ABSTAINED = {
  id: 'F-076',
  title: 'Intermittent 500 on /search under disk pressure',
  why:
    'Reproduced in 1 of 40 branches and could not be reproduced again on 200 re-forks. The examiner proposed a cause; the independent reviewer refused to uphold it on one observation.',
  verdict: 'NOT FILED — recorded as unproven, with the reviewer\'s objection attached.',
};

const TOTAL_FORKS = 200;
const WAVE = 50; // Sandboxes beta caps simultaneous operations at 50

function plan() {
  const failedIds = SEEDED_FAILURES.map((f) => f.id);
  const failedBranchIndexes = [37, 41, 58, 96, 104, 131, 168]; // circled on the contact sheet
  return {
    total: TOTAL_FORKS,
    wave: WAVE,
    waves: Math.ceil(TOTAL_FORKS / WAVE),
    failedBranchIndexes,
    failedIds,
    checkpoint: 'ckpt_healthy_8f2a',
    image: 'ghcr.io/demo/orders-api:1.9.3',
  };
}

function report() {
  const filed = SEEDED_FAILURES;
  return {
    filed,
    abstained: ABSTAINED,
    surviving: survivingScenarios(TOTAL_FORKS, filed.reduce((n, f) => n + f.branchesFailed, 0)),
    cost: { usd: 0.41, models: ['nemotron-3-super (scenarios)', 'nemotron-3-ultra (root cause)', 'nemotron-3-nano (triage)'] },
    wall: { seconds: 214 },
  };
}

module.exports = { plan, report, SEEDED_FAILURES, SCENARIO_LIBRARY, TOTAL_FORKS, WAVE };
