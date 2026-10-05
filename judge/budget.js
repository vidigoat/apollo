/**
 * A ceiling the code cannot spend past.
 *
 * The account this runs against has a **$1 trial**. An in-memory counter is no use for that: a
 * crashed run, a second terminal, a loop restarted after an edit — each starts a fresh process, and
 * a fresh process with a fresh counter will happily spend the whole dollar again. So the ledger is
 * on disk and every call is recorded before the next one is allowed.
 *
 * Three properties, and the third is the one that matters:
 *
 *   PERSISTENT    survives restarts, because that is exactly when an in-memory budget fails
 *   PRE-FLIGHT    refuses a call that *could* exceed the ceiling, not one that already did
 *   FAILS CLOSED  a ledger it cannot read or write means **stop**, never "assume zero spent"
 *
 * That last one is the opposite of the usual instinct. Everywhere else in this project a broken
 * cache degrades to a slower run; here a broken ledger degrades to no run at all, because the
 * failure this guards against is spending money nobody meant to spend.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Deliberately far below the $1 trial. Raise it consciously, once, rather than by accident. */
const DEFAULT_CEILING_USD = 0.25;

const LEDGER =
  process.env.APOLLO_LEDGER ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'apollo', 'spend.json');

/**
 * The most a single call could cost, before it is made.
 *
 * Priced at the output rate for the whole budget, which over-estimates — the prompt is charged at
 * the cheaper input rate and replies are far shorter than maxTokens. Over-estimating is correct
 * here: the question is "could this take me past the line", and a guess that runs low answers it
 * wrong in the direction that costs money.
 */
function worstCase({ rate, maxTokens = 400, promptChars = 4000 }) {
  const promptTokens = Math.ceil(promptChars / 3); // ~3 chars a token, rounded pessimistically
  return (promptTokens * rate.in + maxTokens * rate.out) / 1e6;
}

class Budget {
  constructor({ ceiling = Number(process.env.APOLLO_BUDGET_USD) || DEFAULT_CEILING_USD, file = LEDGER } = {}) {
    this.ceiling = ceiling;
    this.file = file;
  }

  /** @returns {{spent:number, calls:number, since:string}} */
  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const l = JSON.parse(raw);
      if (typeof l.spent !== 'number' || !Number.isFinite(l.spent) || l.spent < 0) {
        throw new Error('ledger is not a number');
      }
      return { spent: l.spent, calls: l.calls || 0, since: l.since || 'unknown' };
    } catch (e) {
      if (e.code === 'ENOENT') return { spent: 0, calls: 0, since: new Date().toISOString() };
      // Corrupt, unreadable, or nonsense. Refusing is the only safe answer: "assume nothing was
      // spent" is how a trial disappears.
      throw new Error(
        `Cannot read the spend ledger at ${this.file} (${e.message}). Refusing to call a paid API ` +
          'rather than assume nothing has been spent. Delete the file to start a fresh ledger.'
      );
    }
  }

  remaining() {
    return Math.max(0, this.ceiling - this.read().spent);
  }

  /**
   * May this call be made? Throws with a usable message if not.
   * @param {object} arg  { rate, maxTokens, promptChars, label }
   */
  check({ rate, maxTokens, promptChars, label = 'a model call' }) {
    const { spent } = this.read();
    const could = worstCase({ rate, maxTokens, promptChars });

    if (spent + could > this.ceiling) {
      throw new Error(
        `Budget stop: ${label} could cost up to $${could.toFixed(6)}, and $${spent.toFixed(4)} of ` +
          `the $${this.ceiling.toFixed(2)} ceiling is already spent.\n` +
          `  Nothing was called. Raise it deliberately with APOLLO_BUDGET_USD=<amount>, or reset ` +
          `the ledger at ${this.file}.`
      );
    }
    return { spent, could, remaining: this.ceiling - spent };
  }

  /** Record what a call actually cost. Written before the caller is told the call succeeded. */
  record(costUsd, { model = 'unknown' } = {}) {
    const before = this.read();
    const entry = {
      spent: Number((before.spent + (Number(costUsd) || 0)).toFixed(8)),
      calls: before.calls + 1,
      since: before.since,
      lastModel: model,
      lastAt: new Date().toISOString(),
      ceiling: this.ceiling,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // A spend that happened and was not recorded is the one state this must never leave behind:
      // the next process would believe the money is still available.
      throw new Error(
        `Spent $${costUsd} but could not record it to ${this.file} (${e.message}). ` +
          'Stopping, because the next run would believe that money is still available.'
      );
    }
    return entry;
  }

  reset() {
    fs.rmSync(this.file, { force: true });
  }

  summary() {
    const { spent, calls } = this.read();
    return `$${spent.toFixed(4)} of $${this.ceiling.toFixed(2)} spent across ${calls} call${calls === 1 ? '' : 's'}`;
  }
}

module.exports = { Budget, worstCase, DEFAULT_CEILING_USD, LEDGER };
