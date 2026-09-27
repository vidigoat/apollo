/**
 * The malware proof: the metric arithmetic (always), and the hardened container (when Docker is here).
 *
 *   node proof/proof.test.js
 *
 * The eval's numbers are only as honest as the counting, so the counting is pinned directly. The
 * containment is the safety claim, so where a runtime exists a synthetic stealer is actually run in
 * one and must come back caught, contained, with nothing having left.
 */
const assert = require('node:assert');
const path = require('node:path');
const { metrics, bareFlags } = require('../scripts/malware-eval');
const { runContained, dockerAvailable } = require('./harden');
const { PROVOCATIONS, CANARY } = require('../interrogate/provocations');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};

(async () => {
  console.log('malware proof');

  await it('detection, false-alarm and lift are counted per label as claimed', () => {
    const rows = [
      { name: 'a', label: 'malicious', bare: false, interrogated: true },
      { name: 'b', label: 'malicious', bare: false, interrogated: true },
      { name: 'c', label: 'malicious', bare: false, interrogated: false },   // an honest miss
      { name: 'd', label: 'benign', bare: true, interrogated: false },        // naive false alarm, interrogation clean
      { name: 'e', label: 'benign', bare: false, interrogated: false },
    ];
    const m = metrics(rows);
    assert.deepEqual(m.bare.detection, { caught: 0, of: 3, pct: 0 });
    assert.deepEqual(m.interrogated.detection, { caught: 2, of: 3, pct: 67 });
    assert.equal(m.liftInDetection, 2, 'the lift interrogation adds was miscounted');
    assert.equal(m.bare.falseAlarm.flagged, 1);
    assert.equal(m.interrogated.falseAlarm.flagged, 0);
    assert.equal(m.changeInFalseAlarms, -1, 'interrogation should reduce false alarms here');
    assert.deepEqual(m.missed, ['c'], 'the honest miss was not named');
  });

  await it('bareFlags is the naive "any network is suspicious" rule', () => {
    assert.equal(bareFlags({ channels: { net: 1 } }), true);
    assert.equal(bareFlags({ channels: { net: 0, env: 3 } }), false);
    assert.equal(bareFlags(undefined), false);
  });

  if (!dockerAvailable()) {
    console.log('  skip  the hardened container test needs Docker (or colima) — not running it');
  } else {
    await it('a synthetic stealer, run in --network none, is caught with the decoy and nothing leaves', async () => {
      const ci = PROVOCATIONS.find((p) => p.id === 'ci-with-npm-token');
      const r = await runContained({ dir: path.join(__dirname, 'corpus', 'stealer-ci'), provocation: ci, canary: CANARY });
      assert.equal(r.code, 0, 'the container did not run cleanly');
      assert.equal(r.observed && r.observed.contained, true, 'the run was not contained');
      assert.ok(r.observed.net.some((n) => n && n.exfil), 'the decoy was not caught on the wire');
    });

    await it('a benign package run in --network none is not flagged as stealing anything', async () => {
      const bare = PROVOCATIONS.find((p) => p.id === 'bare');
      const r = await runContained({ dir: path.join(__dirname, 'corpus', 'benign-quiet'), provocation: bare, canary: CANARY });
      assert.equal(r.observed && r.observed.contained, true);
      assert.ok(!r.observed.net.some((n) => n && n.exfil), 'a benign package was accused of exfiltration');
    });
  }

  console.log(`\n${passed} passed`);
})();
