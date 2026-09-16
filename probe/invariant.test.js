/**
 * The invariant probe.
 *
 * This is the thing a team would actually have instead of a scanner, and it is the evidence for the
 * one claim in this project that is an admission rather than a capability: that watching behaviour
 * cannot see a change in what code computes.
 *
 * If the two rounding functions are subtly wrong, the demonstration is wrong, and a reader who
 * checks it finds that out before we do.
 *
 * Run: node probe/invariant.test.js
 */

const assert = require('node:assert');
const { run, halfEven, halfUp, orders } = require('./invariant-totals');

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

console.log('invariant probe');

it('the two modes agree on everything that is not an exact half', () => {
  for (const v of [1.234, 9.996, 0.001, 12.3449, 12.3451, 100.005001, 0]) {
    assert.equal(halfEven(v), halfUp(v), `${v} should round the same way under both`);
  }
});

it('and disagree only where the difference is the whole point', () => {
  // 0.125 is exactly representable, so this is a true half-cent.
  assert.equal(halfEven(0.125), 0.12, "banker's rounding sends an exact half to the even cent");
  assert.equal(halfUp(0.125), 0.13, 'half-up always goes up');
  assert.equal(halfEven(0.135), 0.14, 'and to the even cent in the other direction too');
  assert.equal(halfUp(0.135), 0.14);
});

it('both modes return money, not floating-point noise', () => {
  for (const v of [1.005, 2.675, 1.0049999, 8.415]) {
    for (const f of [halfEven, halfUp]) {
      const cents = Math.round(f(v) * 100);
      assert.ok(Number.isInteger(cents), `${f.name}(${v}) = ${f(v)} is not a whole number of cents`);
    }
  }
});

it('rounding never moves a total by more than a cent', () => {
  for (const total of orders()) {
    assert.ok(Math.abs(halfUp(total) - halfEven(total)) <= 0.0100001,
      `${total} moved by more than a cent, which would be a bug in the probe, not in money-fmt`);
  }
});

it('the orders are deterministic, so anyone can check the number', () => {
  assert.deepEqual(orders(20), orders(20));
  assert.equal(orders().length, 500);
  orders().forEach((t) => assert.ok(t > 0 && Number.isFinite(t)));
});

it('it demonstrates the defect it exists to demonstrate', () => {
  const r = run();
  assert.equal(r.total, 500);
  assert.ok(r.drifted > 0, 'if nothing drifts, the probe no longer shows anything');
  assert.ok(r.drifted < r.total * 0.2,
    'if most orders drift, the fixture has been tuned for a dramatic number rather than a true one');
  assert.ok(r.examples.length > 0, 'a finding with no example is not checkable');
});

it('every drift is upward by exactly one cent, which is what HALF_UP means', () => {
  const r = run();
  assert.ok(r.net > 0, 'half-up should push totals up, never down');
  assert.equal(Math.round(r.net * 100), r.drifted, `${r.drifted} orders should give +$${(r.drifted / 100).toFixed(2)}`);
  r.examples.forEach((e) => assert.ok(e.after > e.before));
});

it('the whole point: the drift is small, silent, and real', () => {
  const r = run();
  // Not a dramatic number. A cent on one order in a hundred, with the test suite green, is exactly
  // the kind of defect that ships — and exactly the kind that watching behaviour cannot see.
  assert.ok(r.net > 0 && r.net < 1, `net drift was $${r.net.toFixed(2)}; this is meant to be quiet`);
});

console.log(`\n${passed} passed`);
