#!/usr/bin/env node
/**
 * The invariant that catches what watching behaviour cannot.
 *
 *   node probe/invariant-totals.js
 *
 * PLANTED-2 in the corpus is `money-fmt@2.4.2`, which changed its default rounding from HALF_EVEN
 * ("banker's rounding") to HALF_UP in a patch release. That change opens no socket, reads no
 * variable and writes no file, so the behavioural diff is empty and Apollo correctly reports
 * nothing. The README and the interface both say so.
 *
 * This is what a team would have instead: not a scanner, but a claim about their own domain that
 * they can check after an upgrade. "Order totals do not move." It is the cheapest possible test
 * and it catches the entire class of defect that behaviour-watching is blind to.
 *
 * The numbers this prints are the numbers quoted in the README and in corpus.js. They are computed
 * here rather than asserted, because a figure you cannot reproduce is a magic trick.
 */

/** Banker's rounding: exact halves go to the nearest EVEN cent. What money-fmt 2.4.1 did. */
function halfEven(value) {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) > Number.EPSILON * 100) return Math.round(scaled) / 100;
  return (floor % 2 === 0 ? floor : floor + 1) / 100;
}

/** Exact halves always go up. What 2.4.2 does. */
function halfUp(value) {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) > Number.EPSILON * 100) return Math.round(scaled) / 100;
  return (floor + 1) / 100;
}

/**
 * Five hundred orders, deterministic.
 *
 * Whole-cent prices, one to four lines, a 5% tax rate — the most ordinary basket there is. The seed
 * is fixed so this prints the same thing on every machine, forever.
 */
function orders(n = 500) {
  let seed = 20260916;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  return Array.from({ length: n }, () => {
    const lines = 1 + Math.floor(rand() * 4);
    let subtotal = 0;
    for (let i = 0; i < lines; i++) {
      subtotal += (5 + Math.floor(rand() * 4000)) / 100; // prices in whole cents, $0.05–$40.04
    }
    // A 5% tax rate. A subtotal of C cents gives C + C/20, which lands on an exact half-cent
    // whenever C ends in 10 or 30 — about one order in twenty. Nothing here is tuned to produce a
    // particular count; the count is whatever this produces.
    return subtotal * 1.05;
  });
}

function run() {
  const totals = orders();
  let drifted = 0;
  let net = 0;
  const examples = [];

  for (const raw of totals) {
    const before = halfEven(raw);
    const after = halfUp(raw);
    if (before !== after) {
      drifted++;
      net += after - before;
      if (examples.length < 3) examples.push({ raw, before, after });
    }
  }

  return { total: totals.length, drifted, net, examples };
}

if (require.main === module) {
  const r = run();
  const money = (n) => (n < 0 ? '-' : '+') + '$' + Math.abs(n).toFixed(2);

  console.log(`${r.drifted}/${r.total} orders drifted by +0.01   INVARIANT VIOLATED`);
  console.log(`net difference across the batch: ${money(r.net)}`);
  console.log('');
  for (const e of r.examples) {
    console.log(`  ${e.raw.toFixed(4)}  HALF_EVEN ${e.before.toFixed(2)}  ->  HALF_UP ${e.after.toFixed(2)}`);
  }
  console.log('');
  console.log('No syscall differed. No socket opened. The test suite passes.');
  console.log('This is the class of defect that watching behaviour cannot see.');
  process.exitCode = r.drifted > 0 ? 1 : 0;
}

module.exports = { run, halfEven, halfUp, orders };
