#!/usr/bin/env node
/**
 * The same pipeline, against real packages from the real registry, on this machine.
 *
 *   STAKEOUT_ALLOW_LOCAL=1 npm run real -- chalk 5.3.0 5.4.1
 *   STAKEOUT_ALLOW_LOCAL=1 npm run real            # a short default list
 *
 * Everything downstream of the adapter is the code the demo uses. Nothing is simulated except the
 * judgement and the web lookup, and only while their keys are absent — each says so when it is.
 *
 * Read adapters/local.js before running this. The packages execute as you, with your network and
 * your files. It is for proving the pipeline on packages you already trust, never for triaging
 * something you suspect.
 */

const { LocalMachines } = require('../adapters/local');
const { bestStrategy } = require('../observe');
const { runPair } = require('../runPair');
const { diff, summarise } = require('../differ/diff');
const { judgeOne } = require('../judge');
const { lookUp } = require('../evidence/tavily');

const DEFAULT = [
  ['left-pad', '1.2.0', '1.3.0'],   // observably silent at both versions
  ['debug', '4.3.4', '4.4.0'],      // genuinely active — reads DEBUG — and unchanged
  ['picocolors', '1.0.0', '1.1.1'], // the one that actually changed
];

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };
const TONE = { alarming: C.red, notable: C.amber, minor: C.dim, none: C.dim };

(async () => {
  const argv = process.argv.slice(2);
  const jobs = argv.length >= 3 ? [[argv[0], argv[1], argv[2]]] : DEFAULT;

  let machines;
  try {
    machines = new LocalMachines();
  } catch (e) {
    console.error(`\n${C.red}${e.message}${C.off}\n`);
    process.exit(1);
  }

  console.log(`${C.bold}STAKEOUT — real packages, real registry, this machine${C.off}`);
  const strategy = bestStrategy(machines);
  console.log(`${C.dim}Watching with "${strategy}". Node's API surface only — a native addon goes underneath it.${C.off}\n`);

  const checkpoint = await machines.boot();

  for (const [pkg, from, to] of jobs) {
    process.stdout.write(`  ${pkg} ${C.dim}${from} → ${to}${C.off}  `);
    try {
      // Through runPair, not around it: the guarantee that both twins fork from ONE checkpoint and
      // that every branch is released is tested there, and a path that reimplements the sequence is
      // a path that guarantee does not cover.
      const { before, after, diff: d } = await runPair({
        adapter: machines, checkpoint, pkg, from, to, strategy,
      });
      console.log(`${TONE[d.severity]}${d.severity}${C.off}`);
      console.log(`      ${C.dim}${summarise(d)}${C.off}`);

      // What each version actually did — the evidence, not a summary of it.
      for (const [label, t] of [[from, before], [to, after]]) {
        const facts = [
          ...t.env.map((e) => `env ${e}`),
          ...t.dns.map((x) => `dns ${x}`),
          ...t.net.map((n) => `→ ${n.host}:${n.port}`),
          ...t.proc.map((p) => `spawn ${p.argv.join(' ')}`),
          ...t.fs.map((f) => `${f.op} ${f.path}`),
        ];
        console.log(`      ${C.dim}${String(label).padEnd(8)}${facts.length ? facts.join(', ') : 'nothing observed'}${C.off}`);
      }

      if (d.changed) {
        const record = await lookUp(pkg, to);
        const j = await judgeOne(d, record);
        if (j.verdict) console.log(`      ${C.dim}nemotron:${C.off} ${j.verdict.meaning}`);
        console.log(`      ${C.dim}call:${C.off} ${j.accused ? C.red + j.reason + C.off : j.reason}`);
      }
      console.log();
    } catch (e) {
      // runPair releases its own branches in a finally, so there is nothing to clean up here.
      console.log(`${C.red}failed${C.off}\n      ${e.message}\n`);
    }
  }

  console.log(`${C.dim}Machines left open: ${machines.open}${machines.open === 0 ? ` ${C.green}✓${C.off}` : ` ${C.red}← leak${C.off}`}`);
  machines.cleanup();
})();
