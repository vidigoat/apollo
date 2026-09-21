/**
 * The unit of work: one package, two versions, one starting state.
 *
 * Fork the same healthy checkpoint twice. Install the old version in one twin and the new version
 * in the other. Import both. Write down what each did. Diff.
 *
 * The identical starting state is the whole trick — it is what makes the difference attributable to
 * the package rather than to the machine, and it is only affordable because forking a checkpoint
 * costs a fraction of a cent.
 */

const { observePackage, bestStrategy } = require('./observe');
const { diff } = require('./differ/diff');

const WAVE = 50; // Sandboxes caps simultaneous operations. Not a number to raise hopefully.

/**
 * One package at ONE version: a single twin, a single transcript.
 *
 * `runPair` answers "what changed between these two versions". This answers the flatter question
 * the index is built from — "what does this version do?" — because a lockfile pins one version of
 * each package and that is the fact we need to store.
 *
 * It lives here, beside its sibling, for one reason: **every fork in this project must be released
 * by the same code that took it.** `architecture.test.js` enforces that, and it enforces it because
 * a leaked branch is a machine nobody is watching and nobody is paying attention to. The single-
 * version path was briefly written inline in the index builder and the test caught it immediately,
 * which is exactly what it is for.
 */
async function runOne({ adapter, checkpoint, pkg, version, strategy }) {
  const chosen = strategy || bestStrategy(adapter);
  const [branch] = await adapter.fork(checkpoint, 1);

  try {
    return await observePackage({ adapter, branch, pkg, version, strategy: chosen });
  } finally {
    // Whatever happened, give the machine back.
    await adapter.discard(branch);
  }
}

/** One package: two twins, two transcripts, one diff. */
async function runPair({ adapter, checkpoint, pkg, from, to, strategy }) {
  const chosen = strategy || bestStrategy(adapter);
  const [oldBranch, newBranch] = await adapter.fork(checkpoint, 2);

  try {
    // Both branches start from the same instant, which is what makes the comparison mean anything.
    const [before, after] = await Promise.all([
      observePackage({ adapter, branch: oldBranch, pkg, version: from, strategy: chosen }),
      observePackage({ adapter, branch: newBranch, pkg, version: to, strategy: chosen }),
    ]);

    return { pkg, from, to, before, after, diff: diff(before, after) };
  } finally {
    // Whatever happened, give the machines back.
    await Promise.all([adapter.discard(oldBranch), adapter.discard(newBranch)]);
  }
}

/**
 * Every package whose version moved, in waves.
 *
 * Unchanged dependencies are not re-run: in a real upgrade forty packages move out of twelve
 * hundred, and running the other eleven hundred and sixty would be theatre. The full-tree sweep is
 * a separate, deliberate thing — a cold start, not the everyday product.
 */
async function runAll({ adapter, image = 'ghcr.io/demo/orders-api:1.9.3', changed, wave = WAVE, onPair = () => {}, strategy: want } = {}) {
  const startedAt = Date.now();
  const checkpoint = await adapter.boot(image);
  // An explicit strategy is how the interface shows the same corpus read three ways. Falling back
  // to the strongest the adapter admits to is what a real run does.
  const strategy = want || bestStrategy(adapter);

  const results = [];
  const perWave = Math.max(1, Math.floor(wave / 2)); // each package needs two branches

  for (let i = 0; i < changed.length; i += perWave) {
    const slice = changed.slice(i, i + perWave);
    const done = await Promise.all(
      slice.map((c) => runPair({ adapter, checkpoint, pkg: c.pkg, from: c.from, to: c.to, strategy }))
    );
    done.forEach((r) => {
      results.push(r);
      onPair(r);
    });
  }

  const changedBehaviour = results.filter((r) => r.diff.changed);

  return {
    checkpoint,
    strategy,
    pairsRun: results.length,
    twinsForked: results.length * 2,
    results,
    changed: changedBehaviour,
    quiet: results.length - changedBehaviour.length,
    wallMs: Date.now() - startedAt,
  };
}

module.exports = { runPair, runOne, runAll, WAVE };
