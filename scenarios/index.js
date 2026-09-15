/**
 * Scenario families.
 *
 * A family knows two things: how to describe itself to the model that invents concrete scenarios,
 * and how to apply itself inside a forked twin. The engine knows neither — it asks a family for a
 * command and runs it in a branch. Adding a family must never require editing engine.js.
 *
 * `apply()` returns shell to run inside the sandbox. `assert()` returns the probe that decides
 * pass or fail. A scenario has failed only when the probe says so — never because a model thinks so.
 */

const families = {
  dependency: {
    id: 'dependency',
    describe: 'move a dependency within its declared range and re-run the suite',
    apply: ({ pkg, version }) => `npm install ${pkg}@${version} --silent`,
    assert: () => 'npm test --silent && node probe/invariant-totals.js',
    seedsFrom: 'changelogs and advisories for the project\'s direct dependencies',
  },

  input: {
    id: 'input',
    describe: 'send a payload the service did not anticipate',
    apply: ({ payloadFile }) => `cp ${payloadFile} /tmp/payload.json`,
    assert: () => 'node probe/replay.js /tmp/payload.json',
    seedsFrom: 'the service\'s own request schemas, mutated',
  },

  concurrency: {
    id: 'concurrency',
    describe: 'run the same operation concurrently and check the invariant still holds',
    apply: ({ n = 8, staggerMs = 40 }) => `echo "N=${n} STAGGER=${staggerMs}" > /tmp/concurrency.env`,
    assert: () => 'bash probe/concurrent-checkout.sh',
    seedsFrom: 'handlers that read-then-write shared state',
  },

  'dependency-down': {
    id: 'dependency-down',
    describe: 'take a dependency away, then give it back, and measure the recovery',
    apply: ({ host, seconds = 90 }) => `bash probe/blackhole.sh ${host} --for ${seconds}s`,
    assert: () => 'bash probe/recovery.sh',
    seedsFrom: 'incident write-ups about retry storms and cascading failure',
  },

  latency: {
    id: 'latency',
    describe: 'make a dependency slow rather than absent',
    apply: ({ host, ms = 3000 }) => `bash probe/latency.sh ${host} --ms ${ms}`,
    assert: () => 'node probe/timeouts.js',
    seedsFrom: 'timeout and retry configuration in the codebase',
  },

  clock: {
    id: 'clock',
    describe: 'move the clock and see what expires',
    apply: ({ offset = '+26h' }) => `faketime '${offset}' true && echo "${offset}" > /tmp/clock.offset`,
    assert: () => 'node probe/expiry.js',
    seedsFrom: 'token lifetimes, cache TTLs, scheduled work',
  },

  resource: {
    id: 'resource',
    describe: 'run the machine out of something',
    apply: ({ fillPercent = 99 }) => `bash probe/fill-disk.sh --to ${fillPercent}`,
    assert: () => 'node probe/write-paths.js',
    seedsFrom: 'anything that writes to disk without checking',
  },

  auth: {
    id: 'auth',
    describe: 'expire a credential mid-flight',
    apply: () => 'bash probe/expire-token.sh',
    assert: () => 'node probe/refresh.js',
    seedsFrom: 'credential refresh paths',
  },
};

/** Build the command pair the engine runs inside one forked twin. */
function compile(scenario) {
  const family = families[scenario.family];
  if (!family) throw new Error(`Unknown scenario family: ${scenario.family}`);
  return {
    id: scenario.id,
    family: family.id,
    setup: family.apply(scenario.params || {}),
    probe: family.assert(scenario.params || {}),
  };
}

/** What the scenario-writing model is told it can reach for. */
function catalogue() {
  return Object.values(families).map(({ id, describe, seedsFrom }) => ({ id, describe, seedsFrom }));
}

module.exports = { families, compile, catalogue };
