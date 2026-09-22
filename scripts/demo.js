#!/usr/bin/env node
/**
 * The whole argument, in a terminal, in about two seconds.
 *
 *   npm run demo
 *
 * No browser, no keys, no network. Anyone who clones this repo can run it and see the same numbers
 * that are in the README — which is the point. A detection you cannot reproduce is a magic trick.
 */

const { SimulatedSandboxes } = require('../adapters/simulated');
require('../env').loadEnv();
const { sandboxCost } = require('../pricing');
const { runAll } = require('../runPair');
const { judgeOne } = require('../judge');
const { lookUp } = require('../evidence/tavily');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('../corpus');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };

const rule = (s = '') => console.log(`${C.dim}${'─'.repeat(78)}${C.off}${s ? `\n${C.bold}${s}${C.off}` : ''}`);
const TONE = { alarming: C.red, notable: C.amber, minor: C.dim, none: C.dim };

(async () => {
  rule();
  console.log(`${C.bold}STAKEOUT${C.off}  Your lockfile pins versions. This pins behaviour.`);
  rule();

  console.log(`\n  Dependency tree      ${TOTAL.toLocaleString()} packages`);
  console.log(`  Versions moved       ${CHANGED.length}`);
  console.log(`  ${C.dim}The other ${(TOTAL - CHANGED.length).toLocaleString()} are not re-run. Re-running what did not change is theatre.${C.off}`);

  const adapter = new SimulatedSandboxes();
  const started = Date.now();
  const run = await runAll({ adapter, changed: CHANGED });

  console.log(`\n  Forked               ${run.twinsForked} twins from one checkpoint (${run.checkpoint})`);
  console.log(`  Watched with         ${run.strategy}`);
  console.log(`  Wall clock           ${Date.now() - started} ms`);
  console.log(`  Machines left open   ${adapter.open}  ${adapter.open === 0 ? C.green + '✓' + C.off : C.red + '← leak' + C.off}`);

  /* ── the silence ──────────────────────────────────────────────────── */

  rule('WHAT CHANGED');
  console.log(`\n  ${C.dim}${run.quiet} of ${CHANGED.length} packages behaved identically at both versions.${C.off}`);
  console.log(`  ${C.dim}That silence is the finding. It is what gives the rest their weight.${C.off}\n`);

  const changed = run.results.filter((p) => p.diff.changed);
  let modelCalls = 0;
  let accused = [];
  // Tallied from the spend records rather than assumed, so the footer can say what actually ran.
  let modelSpendUsd = 0;
  let anyLiveModel = false;
  // Calls this run actually MADE, as opposed to calls the verdicts are based on. A cached
  // judgement still carries the spend record of the run that produced it, so counting those
  // reports nine live calls for a run that made none.
  let freshCalls = 0;
  let cachedJudgements = 0;

  for (const p of changed) {
    const record = await lookUp(p.pkg, p.to, { recorded: PUBLIC_RECORD });
    const j = await judgeOne(p.diff, record);
    modelCalls += j.spend.length;
    if (j.cached) cachedJudgements++;
    else freshCalls += j.spend.length;
    modelSpendUsd += j.cached ? 0 : j.costUsd || 0;
    if (j.spend.some((c) => c.simulated === false)) anyLiveModel = true;
    if (j.accused) accused.push(p.pkg);

    const tone = TONE[p.diff.severity];
    console.log(`  ${tone}${p.diff.severity.toUpperCase().padEnd(9)}${C.off} ${p.pkg} ${C.dim}${p.from} → ${p.to}${C.off}`);
    for (const r of p.diff.reasons) console.log(`      ${C.dim}·${C.off} ${r}`);
    if (j.verdict) console.log(`      ${C.dim}nemotron:${C.off} ${j.verdict.meaning}`);
    console.log(`      ${C.dim}web:${C.off} ${record.verdict}`);
    console.log(`      ${C.dim}call:${C.off} ${j.accused ? C.red + j.reason + C.off : j.reason}\n`);
  }

  /* ── the same package, watched two ways ───────────────────────────── */

  const { transcript } = require('../transcript/schema');
  const { diff } = require('../differ/diff');
  const { behaviourFor } = require('../corpus');

  rule('THE SAME PACKAGE, WATCHED TWO WAYS');
  console.log(`\n  ${C.dim}flat-config 3.2.0 → 3.2.1 decodes a blob, turns it into a function, and only`);
  console.log(`  then opens a socket. Whether that is notable or alarming depends entirely on`);
  console.log(`  what was watching.${C.off}\n`);

  for (const strategy of ['fsdiff', 'ebpf', 'nodert']) {
    const d = diff(
      transcript({ pkg: 'flat-config', version: '3.2.0', strategy, raw: behaviourFor('flat-config', '3.2.0') }),
      transcript({ pkg: 'flat-config', version: '3.2.1', strategy, raw: behaviourFor('flat-config', '3.2.1') })
    );
    /*
     * `!== true`, not `!v`. A channel can be watched in part — nodert records filesystem writes
     * and no reads — and truthy is not the same as seen. Under `!v` this line printed nothing at
     * all for nodert, so the demo's own "three honest answers" was quietly making the strongest
     * claim on the page about the strategy with a gap in it.
     */
    const table = Object.entries(d.canSee);
    const unseen = table.filter(([, v]) => v === false).map(([k]) => k);
    const partial = table.filter(([, v]) => v !== true && v !== false).map(([k, v]) => `${k}, and only its ${v}`);

    console.log(`  ${strategy.padEnd(8)} ${TONE[d.severity]}${d.severity.toUpperCase().padEnd(9)}${C.off} ${d.reasons[0] || 'nothing observed'}`);
    if (unseen.length) console.log(`           ${C.dim}cannot see: ${unseen.join(', ')}${C.off}`);
    // Said separately from "cannot see", because "cannot see: fs (writes only)" reads as though
    // the filesystem were invisible, and half-watched is a different claim from unwatched.
    if (partial.length) console.log(`           ${C.dim}watches ${partial.join('; ')}${C.off}`);
  }

  console.log(`\n  ${C.dim}Same package, same bytes, three honest answers. A string becoming a function`);
  console.log(`  never becomes a syscall, so the kernel tracer sees a socket it cannot explain.`);
  console.log(`  This is why every transcript carries the strategy that produced it.${C.off}`);

  /* ── the blind spot ───────────────────────────────────────────────── */

  const invisible = Object.entries(INVARIANT_FAILURES);
  if (invisible.length) {
    rule('WHAT WATCHING BEHAVIOUR CANNOT SEE');
    for (const [key, inv] of invisible) {
      console.log(`\n  ${key}  ${C.dim}— no observable behavioural change at all${C.off}`);
      console.log(`  ${C.dim}$ ${inv.probe}${C.off}`);
      inv.output.split('\n').forEach((l) => console.log(`  ${C.amber}${l}${C.off}`));
      console.log(`  ${inv.note}`);
    }
  }

  /* ── the bill ─────────────────────────────────────────────────────── */

  rule('THE BILL');
  const sandbox = sandboxCost(run.twinsForked);
  console.log(`\n  ${run.twinsForked} sandboxes          ${sandbox.label}`);
  console.log(`  ${modelCalls} model calls        ${C.dim}(not ${changed.length * 3} — triage is the design)${C.off}`);
  if (cachedJudgements) {
    console.log(`  ${C.dim}${freshCalls} of them actually ran — ${cachedJudgements} verdict${cachedJudgements === 1 ? '' : 's'} came from cache, costing nothing${C.off}`);
  }
  console.log(`  ${run.quiet} quiet packages     0 model calls, 0 searches`);
  console.log(`\n  ${C.bold}Accused: ${accused.length ? C.red + accused.join(', ') + C.off : 'nothing'}${C.off}`);
  console.log(`  ${C.dim}An accusation needs two independent models to agree. One model is an opinion.${C.off}`);

  rule();
  /*
   * What was real in THIS run, decided by the run rather than typed.
   *
   * This line read "Simulated sandboxes, recorded web results, offline model fallback" as a fixed
   * string. The first time the demo ran against a live Nebius key it made nine real Nemotron calls,
   * billed them, printed their verdicts — and then told the reader underneath that the models had
   * been simulated. A footer that describes the run has to be derived from the run; a constant
   * describing a variable is only true until the day it matters.
   */
  const modelNote = anyLiveModel && freshCalls > 0
    ? `LIVE NVIDIA Nemotron 3 on Nebius Token Factory — ${freshCalls} call${freshCalls === 1 ? '' : 's'} this run, $${modelSpendUsd.toFixed(4)}`
    : anyLiveModel
      ? `every verdict served from cache — 0 model calls, $0.0000`
      : 'offline model fallback (no NEBIUS_API_KEY set)';
  console.log(`${C.dim}Simulated sandboxes, recorded web results, ${modelNote} — all labelled`);
  console.log(`as such above and in the repository. \`npm start\` for the same run in a browser.${C.off}`);
  rule();
})();
