/**
 * What a run costs, and how much of that we actually know.
 *
 * Two numbers appear on the page and in `npm run demo`, and they are not the same kind of number:
 *
 *   model calls    MEASURED. Every paid call returns a usage block, the rate table in
 *                  judge/nemotron.js is published per million tokens, and judge/budget.js records
 *                  what was actually spent to a ledger on disk. That figure is arithmetic on real
 *                  usage.
 *
 *   sandboxes      ESTIMATED. This project has never forked a live Nebius sandbox — see the
 *                  "what is real and what is simulated" table in the README. The per-sandbox figure
 *                  below is a placeholder, and until a real fork returns a real bill it must be
 *                  rendered as an estimate everywhere it appears.
 *
 * It was previously the bare literal `0.0146`, written into four files with no name, no source and
 * no label, and printed as `$0.44` next to measured model spend as though the two were equally
 * solid. A reader has no way to tell a measured number from an invented one unless the code says
 * which it is, and a made-up cost sitting beside a real one quietly borrows its credibility.
 *
 * If you have real pricing, set APOLLO_SANDBOX_USD and the label stops saying "est.".
 */

/**
 * Placeholder price for one forked sandbox, in USD.
 *
 * Chosen to be the right order of magnitude for a short-lived fork of an already-booted machine —
 * a fraction of a cent to a couple of cents. It is not a quote, it is not from a price list, and
 * nothing in this repository has ever been billed for it.
 */
const ESTIMATED_SANDBOX_USD = 0.0146;

/** True once somebody supplies a real price, which is the only thing that removes the caveat. */
const sandboxPriceIsKnown = () => Number.isFinite(Number(process.env.APOLLO_SANDBOX_USD));

const sandboxUnitPrice = () =>
  sandboxPriceIsKnown() ? Number(process.env.APOLLO_SANDBOX_USD) : ESTIMATED_SANDBOX_USD;

/**
 * @returns {{usd:number, estimated:boolean, label:string}}
 *   `label` is what to print. It carries the caveat so a caller cannot render the number without it.
 */
function sandboxCost(twins) {
  const usd = Number((twins * sandboxUnitPrice()).toFixed(4));
  const estimated = !sandboxPriceIsKnown();
  return {
    usd,
    estimated,
    label: estimated ? `~$${usd.toFixed(2)} est.` : `$${usd.toFixed(2)}`,
  };
}

module.exports = { sandboxCost, sandboxUnitPrice, ESTIMATED_SANDBOX_USD, sandboxPriceIsKnown };
