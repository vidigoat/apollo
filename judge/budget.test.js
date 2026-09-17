/**
 * The spend ceiling.
 *
 * This guards a **$1 trial account**, which changes what "correct" means. Everywhere else in this
 * project a broken component degrades to a slower run; here it has to degrade to *no* run, because
 * the failure being guarded against is spending money nobody meant to spend.
 *
 * The bug it was written after: the first run of nemotron.test.js put $0.50 of imaginary money into
 * the real ledger. The guard then refused to make any further call — correctly. The test was wrong,
 * not the guard, and that is the behaviour this file pins.
 *
 * Run: node judge/budget.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Budget, worstCase } = require('./budget');

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

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')), 'spend.json');
const RATE = { in: 1, out: 3 };
const call = { rate: RATE, maxTokens: 400, promptChars: 4000 };

console.log('budget');

it('an empty ledger is zero spent, not an error', () => {
  const b = new Budget({ ceiling: 1, file: tmp() });
  assert.equal(b.read().spent, 0);
  assert.equal(b.remaining(), 1);
});

it('spend accumulates across separate Budget objects', () => {
  // The whole reason it is on disk. Each of these stands in for a separate process — a crashed run,
  // a second terminal, a loop restarted after an edit.
  const file = tmp();
  new Budget({ ceiling: 1, file }).record(0.1);
  new Budget({ ceiling: 1, file }).record(0.2);
  assert.equal(Number(new Budget({ ceiling: 1, file }).read().spent.toFixed(4)), 0.3);
  assert.equal(new Budget({ ceiling: 1, file }).read().calls, 2);
});

it('it refuses before the call, not after', () => {
  const b = new Budget({ ceiling: 0.001, file: tmp() });
  assert.throws(() => b.check(call), /Budget stop/);
  assert.throws(() => b.check(call), /Nothing was called/, 'the message has to say nothing was spent');
  assert.equal(b.read().calls, 0, 'a refused call must not be recorded as a call');
});

it('the refusal says how to proceed deliberately', () => {
  const b = new Budget({ ceiling: 0.001, file: tmp() });
  try {
    b.check(call);
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /STAKEOUT_BUDGET_USD/, 'a limit with no documented override is a wall');
    assert.match(e.message, /ceiling is already spent/);
  }
});

it('the estimate is pessimistic, because a low guess costs money', () => {
  // Priced at the OUTPUT rate for the whole budget. A guess that runs low answers "could this take
  // me past the line" wrongly, in the direction that spends.
  const est = worstCase(call);
  const actual = (1333 * RATE.in + 120 * RATE.out) / 1e6; // a realistic prompt and a short reply
  assert.ok(est > actual, `estimate ${est} should exceed a realistic ${actual}`);
  assert.ok(est < 0.01, 'but not so pessimistic that nothing is ever allowed');
});

it('an unreadable ledger stops everything', () => {
  // The opposite of every other failure path in this project, deliberately. "Assume nothing was
  // spent" is how a trial disappears.
  const file = tmp();
  fs.writeFileSync(file, '{ not json');
  const b = new Budget({ ceiling: 1, file });
  assert.throws(() => b.read(), /Refusing to call a paid API/);
  assert.throws(() => b.check(call), /Refusing to call a paid API/);
});

it('a nonsense ledger is refused, not believed', () => {
  for (const junk of ['{"spent":"lots"}', '{"spent":-5}', '{"spent":null}', '[]']) {
    const file = tmp();
    fs.writeFileSync(file, junk);
    assert.throws(() => new Budget({ ceiling: 1, file }).read(), /Refusing/, `believed: ${junk}`);
  }
});

it('a spend that cannot be recorded is an error, not a shrug', () => {
  // The one state it must never leave behind: money gone, ledger silent, next run believing it is
  // still available.
  const b = new Budget({ ceiling: 1, file: '/proc/nowhere/spend.json' });
  assert.throws(() => b.record(0.05), /could not record it/);
});

it('a ledger is never left half-written', () => {
  const file = tmp();
  const b = new Budget({ ceiling: 1, file });
  b.record(0.01);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'a temp file survived the write');
});

it('the ceiling is well under the trial it guards', () => {
  // The account has $1. A default that could consume it in one run is not a guard.
  const { DEFAULT_CEILING_USD } = require('./budget');
  assert.ok(DEFAULT_CEILING_USD <= 0.25, `default ceiling is $${DEFAULT_CEILING_USD}; the trial is $1`);
});

it('it can say where it stands in one line', () => {
  const b = new Budget({ ceiling: 0.25, file: tmp() });
  b.record(0.0123, { model: 'nano' });
  assert.match(b.summary(), /\$0\.0123 of \$0\.25 spent across 1 call$/);
});

console.log(`\n${passed} passed`);
