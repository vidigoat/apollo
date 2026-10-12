#!/usr/bin/env node
/**
 * The page's "measured, not claimed" section, computed from the reports the measurements wrote.
 *
 *   node scripts/evidence.js        # docs/*.json + public/live-watch.json → public/evidence.json
 *
 * Each figure is derived here from a committed report, with the report and the date it was measured.
 * scripts/evidence.test.js fails if public/evidence.json ever disagrees with what this computes.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const n = (x) => x.toLocaleString('en-US');
const day = (iso) => String(iso).slice(0, 10);

function evidence() {
  const cross = read('docs/crossval.json');
  const hold = read('docs/holdout-46.json');
  const inst = read('docs/install-phase.json');
  const rel = read('docs/release-watch.json');
  const surveyed = Object.values(rel.tally).reduce((a, b) => a + b, 0);
  return {
    items: [
      {
        figure: `${cross.identical} / ${cross.compared}`,
        label: 'Mac observations reproduced on Nebius',
        detail: `Re-observed in Nebius Sandboxes and matched on every channel; ${cross.differing} did not, and is named in the report.`,
        source: 'docs/crossval.json',
        measured: day(cross.measured),
      },
      {
        figure: `${hold.pct}%`,
        label: 'of unseen repositories answered at once',
        detail: `${n(hold.answered)} of ${n(hold.depVersions)} dependency-versions across ${hold.repos} public repositories never used to build the index.`,
        source: 'docs/holdout-46.json',
        measured: day(hold.measured),
      },
      {
        figure: n(inst.watchedThroughInstall),
        label: 'packages watched through install',
        detail: `${n(inst.ranScript)} ran an install script; ${n(inst.reachedNetwork)} reached the network and ${n(inst.readCredentialLike)} read a credential-like variable while doing it.`,
        source: 'docs/install-phase.json',
        measured: day(inst.measured),
      },
      {
        figure: `${n(rel.tally.none)} / ${n(surveyed)}`,
        label: 'top releases behaved exactly as before',
        detail: `The newest release of each of the most-downloaded packages, against the one before; ${n(rel.tally.alarming)} alarming, each read by hand.`,
        source: 'docs/release-watch.json',
        measured: day(rel.measured),
      },
    ],
  };
}

module.exports = { evidence };

if (require.main === module) {
  fs.writeFileSync(path.join(ROOT, 'public', 'evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`);
  console.log('  public/evidence.json written');
}
