/**
 * The corpus, held to what the README claims about it.
 *
 * Every number in the README — 1,214 packages, 14 moved, 10 quiet, 3 planted — is a claim someone
 * evaluating this project will check. Numbers in prose drift silently; numbers a test asserts do
 * not. So the README's arithmetic lives here.
 *
 * The other thing being protected is the shape of the benchmark itself. A corpus where every plant
 * is a true positive can be won by flagging everything, and a tool that flags everything is not a
 * tool. Two of the three plants exist to punish exactly that, and this file checks they are still
 * there and still doing their job.
 *
 * Run: node corpus.test.js
 */

const assert = require('node:assert');
const { TOTAL, CHANGED, BEHAVIOUR, INVARIANT_FAILURES, PUBLIC_RECORD, behaviourFor } = require('./corpus');
const { SimulatedSandboxes } = require('./adapters/simulated');
const { runAll } = require('./runPair');

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

const planted = (id) => CHANGED.find((c) => c.planted === id);

(async () => {
  console.log('corpus');

  await it('the numbers the README prints are the numbers the corpus has', () => {
    assert.equal(TOTAL, 1214);
    assert.equal(CHANGED.length, 14);
    assert.ok(CHANGED.length < TOTAL / 50, 'most of a real tree does not move between installs');
  });

  await it('every planted package is labelled as planted, in the data itself', () => {
    const ids = CHANGED.filter((c) => c.planted).map((c) => c.planted).sort();
    assert.deepEqual(ids, ['PLANTED-1', 'PLANTED-2', 'PLANTED-3']);
    assert.equal(ids.length, 3, 'a plant that is not labelled is a magic trick');
  });

  await it('no package appears twice — a duplicate would be counted twice everywhere', () => {
    const names = CHANGED.map((c) => c.pkg);
    assert.equal(new Set(names).size, names.length);
  });

  await it('every entry moves to a different version than it came from', () => {
    CHANGED.forEach((c) => {
      assert.ok(c.from && c.to, `${c.pkg} is missing a version`);
      assert.notEqual(c.from, c.to, `${c.pkg} did not actually move`);
    });
  });

  /* ── the three plants, each doing a different job ───────────────────── */

  await it('PLANTED-1 is a true positive: it reads a credential and sends it somewhere', () => {
    const p = planted('PLANTED-1');
    const after = behaviourFor(p.pkg, p.to);
    const before = behaviourFor(p.pkg, p.from);
    assert.ok(after.env.some((e) => /SECRET|TOKEN|KEY/i.test(e)), 'nothing sensitive is read');
    assert.ok(after.net.length > (before.net || []).length, 'nothing new is contacted');
    assert.ok(!(before.env || []).some((e) => /SECRET|TOKEN|KEY/i.test(e)),
      'the old version reads it too, so the diff would show nothing');
  });

  await it('PLANTED-2 is a true negative for this approach — and admits it', () => {
    const p = planted('PLANTED-2');
    assert.deepEqual(behaviourFor(p.pkg, p.from), behaviourFor(p.pkg, p.to),
      'if this one has observable behaviour, it is not testing the blind spot any more');
    const admission = INVARIANT_FAILURES[`${p.pkg}@${p.to}`];
    assert.ok(admission, 'the miss must be documented somewhere the interface can show it');
    assert.ok(admission.probe && admission.output && admission.note);
  });

  await it('PLANTED-3 is the hard negative: real new behaviour, honestly documented', () => {
    const p = planted('PLANTED-3');
    const after = behaviourFor(p.pkg, p.to);
    assert.ok(after.net.length, 'it has to actually contact something, or it proves nothing');
    const record = PUBLIC_RECORD[`${p.pkg}@${p.to}`];
    assert.ok(record?.changelog, 'the whole point is that the maintainer announced it');
  });

  await it('the plants are not the only thing in the corpus', () => {
    const ordinary = CHANGED.filter((c) => !c.planted);
    assert.ok(ordinary.length >= 10, 'a corpus of nothing but plants is a rigged test');
  });

  /* ── what a run of it actually produces ─────────────────────────────── */

  await it('silence dominates a real run — if it does not, the corpus is wrong', async () => {
    const r = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    assert.equal(r.pairsRun, 14);
    assert.equal(r.twinsForked, 28);
    assert.ok(r.quiet > r.changed.length, `${r.quiet} quiet vs ${r.changed.length} changed`);
    assert.equal(r.quiet, 10, 'the README says 10 of 14 behaved identically');
  });

  await it('exactly one package is alarming, and it is the one we planted to be', async () => {
    const r = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    const alarming = r.results.filter((p) => p.diff.severity === 'alarming');
    assert.equal(alarming.length, 1, 'a second alarming package means the rules got noisier');
    assert.equal(alarming[0].pkg, planted('PLANTED-1').pkg);
  });

  await it('the run is deterministic — the same corpus twice gives the same answer', async () => {
    const one = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    const two = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    assert.equal(
      JSON.stringify(one.results.map((p) => p.diff)),
      JSON.stringify(two.results.map((p) => p.diff)),
      'a demo that differs between runs cannot be checked by anyone'
    );
  });

  await it('the recorded web results only cover packages that exist here', () => {
    Object.keys(PUBLIC_RECORD).forEach((key) => {
      const [pkg] = key.split('@');
      assert.ok(CHANGED.some((c) => c.pkg === pkg), `${key} is a record for a package not in the tree`);
    });
  });

  console.log(`\n${passed} passed`);
})();
