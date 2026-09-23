#!/usr/bin/env node
/**
 * Publish the verdicts the hosted demo will serve.
 *
 *   npm run warm-cache
 *
 * Runs the fixture exactly as `/api/run` does, then copies the resulting judgements out of the
 * local cache and into `judge/verdicts/`, which is committed.
 *
 * ── Why this is a separate, deliberate step ─────────────────────────────────
 *
 * Nebius requires a working demo URL, and a serverless filesystem is ephemeral and read-only: a
 * cache in the home directory does not survive a cold start, so every visitor would arrive to an
 * empty one and trigger nine live Nemotron calls. A demo URL that bills per refresh is a demo URL
 * you end up taking down, which is the one outcome the requirement is trying to prevent.
 *
 * It is not automatic on purpose. What a stranger sees on the hosted demo should be a set of
 * verdicts somebody looked at and chose to ship — not whatever the last run happened to produce,
 * and not a verdict formed while a prompt was half-edited. Committing them also makes them
 * reviewable: they are JSON in the diff, and a reader can see exactly what the models said.
 */

const fs = require('node:fs');
const path = require('node:path');
require('../env').loadEnv();

const { runAll } = require('../runPair');
const { SimulatedSandboxes } = require('../adapters/simulated');
const { CHANGED, PUBLIC_RECORD } = require('../corpus');
const { lookUp } = require('../evidence/tavily');
const { judgeOne } = require('../judge');
const { hasKey } = require('../judge/nemotron');
const { JudgementCache, SHIPPED_DIR, keyFor } = require('../judge/cache');
const { MODELS } = require('../judge/nemotron');
const { Budget } = require('../judge/budget');

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', bold: '', off: '' };

(async () => {
  console.log(`\n  ${C.bold}Warming the verdicts the hosted demo will serve${C.off}\n`);

  if (!hasKey()) {
    console.error(`  ${C.red}NEBIUS_API_KEY is not set.${C.off}`);
    console.error(`  ${C.dim}Without it every verdict would be simulated, and a simulated verdict is never`);
    console.error(`  cached — deliberately, so one keyless run cannot poison every keyed one. Nothing`);
    console.error(`  would be written and the hosted demo would stay cold.${C.off}\n`);
    process.exitCode = 1;
    return;
  }

  const budget = new Budget();
  console.log(`  ${C.dim}budget before: ${budget.summary()}${C.off}`);

  /*
   * Every strategy the page offers, not only the default.
   *
   * The key includes the diff's evidence, and what a strategy can see changes the evidence — so a
   * verdict warmed under ebpf is no answer under nodert. Recorded footage of the demo showed it:
   * switching the tab to nodert, the shot this project is built around, put "simulated, no key"
   * next to the NVIDIA model on the hosted page.
   */
  const { STRATEGIES } = require('../transcript/schema');
  let changed = [];
  for (const strategy of STRATEGIES) {
    const run = await runAll({ adapter: new SimulatedSandboxes(), changed: CHANGED, strategy });
    changed = changed.concat(run.results.filter((p) => p.diff.changed));
  }

  const cache = new JudgementCache();
  let fresh = 0;
  let served = 0;

  for (const p of changed) {
    const record = await lookUp(p.pkg, p.to, { recorded: PUBLIC_RECORD });
    const j = await judgeOne(p.diff, record);
    if (j.cached) served++;
    else fresh++;
    console.log(`  ${j.cached ? C.dim + 'cached' : C.green + 'ran   '}${C.off} ${p.pkg.padEnd(24)} ${C.dim}${p.diff.severity}${C.off}`);
  }

  // Copy the local cache into the repository. Only the entries this run touched, so a stale verdict
  // from an older prompt cannot ride along unnoticed.
  let published = 0;
  for (const p of changed) {
    const record = await lookUp(p.pkg, p.to, { recorded: PUBLIC_RECORD });
    const id = keyFor({ diff: p.diff, models: MODELS, record });
    const from = cache.path(id);
    const to = path.join(SHIPPED_DIR, id.slice(0, 2), `${id}.json`);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      published++;
    } catch (e) {
      console.error(`  ${C.red}could not publish ${p.pkg}: ${e.message}${C.off}`);
    }
  }

  console.log(`\n  ${C.green}${published} verdict${published === 1 ? '' : 's'} published to judge/verdicts/${C.off}`);
  console.log(`  ${C.dim}${fresh} ran, ${served} already cached · ${budget.summary()}${C.off}`);
  console.log(`  ${C.dim}Commit them. A cold serverless start now serves these instead of billing a visitor.${C.off}\n`);
})();
