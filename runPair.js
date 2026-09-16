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
async function runAll({ adapter, image = 'ghcr.io/demo/orders-api:1.9.3', changed, wave = WAVE, onPair = () => {} }) {
  const startedAt = Date.now();
  const checkpoint = await adapter.boot(image);
  const strategy = bestStrategy(adapter);

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

module.exports = { runPair, runAll, WAVE };
