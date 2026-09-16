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
    assert.equal(CHANGED.length, 15);
    assert.ok(CHANGED.length < TOTAL / 50, 'most of a real tree does not move between installs');
  });

  await it('every planted package is labelled as planted, in the data itself', () => {
    const ids = CHANGED.filter((c) => c.planted).map((c) => c.planted).sort();
    assert.deepEqual(ids, ['PLANTED-1', 'PLANTED-2', 'PLANTED-3', 'PLANTED-4']);
    assert.equal(ids.length, 4, 'a plant that is not labelled is a magic trick');
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

    // The number in that output must come from actually running the probe, never from prose.
    const { run } = require('./probe/invariant-totals');
    const r = run();
    assert.ok(r.drifted > 0, 'the probe no longer demonstrates the defect it is here to demonstrate');
    assert.match(admission.output, new RegExp(`^${r.drifted}/${r.total}\\b`),
      'the admission quotes a number the probe does not produce');
    assert.equal(run().drifted, r.drifted, 'the probe is not deterministic, so nobody can check it');
  });

  await it('PLANTED-3 is the hard negative: real new behaviour, honestly documented', () => {
    const p = planted('PLANTED-3');
    const after = behaviourFor(p.pkg, p.to);
    assert.ok(after.net.length, 'it has to actually contact something, or it proves nothing');
    const record = PUBLIC_RECORD[`${p.pkg}@${p.to}`];
    assert.ok(record?.changelog, 'the whole point is that the maintainer announced it');
  });

  await it('the same package reads differently depending on who watched it', () => {
    // The point of PLANTED-4, and the reason every transcript carries its strategy.
    //
    // flat-config decodes a blob, turns it into a function, and only then opens a socket. eBPF
    // sees the socket and nothing that explains it — notable. nodert sees the string becoming
    // executable — alarming. Same package, same version, same bytes; two honest answers, and the
    // transcript says which question was asked.
    const { transcript } = require('./transcript/schema');
    const { diff } = require('./differ/diff');
    const p = planted('PLANTED-4');
    const before = behaviourFor(p.pkg, p.from);
    const after = behaviourFor(p.pkg, p.to);

    const read = (strategy) => diff(
      transcript({ pkg: p.pkg, version: p.from, strategy, raw: before }),
      transcript({ pkg: p.pkg, version: p.to, strategy, raw: after })
    );

    const byKernel = read('ebpf');
    const byRuntime = read('nodert');

    assert.equal(byKernel.severity, 'notable', 'eBPF should see the socket and stop there');
    assert.equal(byKernel.exec.added.length, 0, 'eBPF must not report a channel it cannot see');

    assert.equal(byRuntime.severity, 'alarming', 'nodert should see the code being built');
    assert.match(byRuntime.reasons.join(' '), /did not exist in the source/);

    // And the filesystem-only strategy sees none of it, and says so rather than reporting calm.
    const byFs = read('fsdiff');
    assert.equal(byFs.changed, false);
    assert.equal(byFs.canSee.net, false, 'a quiet fsdiff run must carry the reason it was quiet');
  });

  await it('PLANTED-4 is caught by what watched it, and would be missed by eBPF', () => {
    const p = planted('PLANTED-4');
    const after = behaviourFor(p.pkg, p.to);
    assert.ok(after.exec?.length, 'the decoder has to actually build code, or it proves nothing');
    assert.ok(after.exec.some((e) => e.how === 'Function'), 'a decode with no execution is not this plant');
    assert.ok(after.net?.length, 'and it has to reach the network, so eBPF sees SOMETHING');

    // The point of the plant: the half that explains the socket never becomes a syscall.
    const { CAN_SEE } = require('./transcript/schema');
    assert.equal(CAN_SEE.ebpf.exec, false, 'if eBPF could see this, the plant demonstrates nothing');
    assert.equal(CAN_SEE.nodert.exec, true);
  });

  await it('the plants are not the only thing in the corpus', () => {
    const ordinary = CHANGED.filter((c) => !c.planted);
    assert.ok(ordinary.length >= 10, 'a corpus of nothing but plants is a rigged test');
  });

  /* ── what a run of it actually produces ─────────────────────────────── */

  await it('silence dominates a real run — if it does not, the corpus is wrong', async () => {
    const r = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    assert.equal(r.pairsRun, 15);
    assert.equal(r.twinsForked, 30);
    assert.ok(r.quiet > r.changed.length, `${r.quiet} quiet vs ${r.changed.length} changed`);
    assert.equal(r.quiet, 10, 'the README says 10 of 15 behaved identically');
  });

  await it('exactly one package is alarming, and it is the one we planted to be', async () => {
    const r = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED });
    const alarming = r.results.filter((p) => p.diff.severity === 'alarming');
    // One, under eBPF. The decoder is caught too — but only by a strategy that can see code being
    // built, and this run was watched with eBPF, which cannot. See the next test.
    assert.equal(alarming.length, 1, `alarming: ${alarming.map((p) => p.pkg).join(', ')}`);
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
