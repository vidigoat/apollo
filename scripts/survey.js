#!/usr/bin/env node
/**
 * A survey of the real registry.
 *
 *   STAKEOUT_ALLOW_LOCAL=1 npm run survey
 *
 * Everything else here answers "does the machinery work". This asks the question the machinery was
 * built for, about software nobody involved controls:
 *
 *   across a few dozen real upgrades of genuinely popular packages, how many behave differently at
 *   all — and what do the ones that do actually do?
 *
 * The expected answer is *almost none*, and that is the finding. A tool whose baseline is unknown
 * cannot tell you whether a result is unusual, and "one package in thirty reads a new environment
 * variable" only means something once you know the other twenty-nine read nothing.
 *
 * Every pair below is a real version of a real package on npm. The results are whatever they are;
 * nothing here is selected for being interesting, which is the only way the baseline is worth
 * anything. Results are cached, so a second survey is close to free.
 */

const { LocalMachines } = require('../adapters/local');
require('../env').loadEnv();
const { bestStrategy } = require('../observe');
const { runPair } = require('../runPair');
const { summarise } = require('../differ/diff');
const { BehaviourCache } = require('../cache');

const { PAIRS } = require('./survey-pairs');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };
const TONE = { alarming: C.red, notable: C.amber, minor: C.dim, none: C.dim };

module.exports = { PAIRS };

if (require.main === module) main();

async function main() {
  let machines;
  try {
    machines = new LocalMachines({ timeoutMs: 120_000 });
  } catch (e) {
    console.error(`\n  ${C.red}${e.message}${C.off}\n`);
    process.exit(1);
  }

  const cache = new BehaviourCache();
  const strategy = bestStrategy(machines);

  console.log(`\n  ${C.bold}STAKEOUT — a survey of the real registry${C.off}`);
  console.log(`  ${C.dim}${PAIRS.length} upgrades of genuinely popular packages, watched with "${strategy}".`);
  console.log(`  Nothing here is chosen for being interesting — that is the point of a baseline.${C.off}\n`);

  const checkpoint = await machines.boot();
  const tally = { none: 0, minor: 0, notable: 0, alarming: 0, failed: 0 };
  const interesting = [];

  for (const [pkg, from, to] of PAIRS) {
    process.stdout.write(`  ${pkg.padEnd(24)} ${C.dim}${from} → ${to}${C.off}  `);
    const job = { pkg, from, to, strategy };

    const known = cache.get(job);
    if (known) {
      tally[known.severity]++;
      console.log(`${TONE[known.severity]}${known.severity}${C.off} ${C.dim}· cached${C.off}`);
      if (known.changed) interesting.push({ pkg, from, to, d: known });
      continue;
    }

    try {
      // runPair or nothing: the one-checkpoint guarantee is tested there.
      const { diff: d } = await runPair({ adapter: machines, checkpoint, pkg, from, to, strategy });
      cache.put(job, d);
      tally[d.severity]++;
      console.log(`${TONE[d.severity]}${d.severity}${C.off}`);
      if (d.changed) interesting.push({ pkg, from, to, d });
    } catch (e) {
      // A package that will not install on this machine is a fact about that package. It is
      // counted separately and never as "behaved identically", which would be a lie by omission.
      tally.failed++;
      console.log(`${C.amber}could not run${C.off} ${C.dim}${String(e.message).slice(0, 60)}${C.off}`);
    }
  }

  const ran = PAIRS.length - tally.failed;
  console.log(`\n  ${C.dim}${'─'.repeat(72)}${C.off}`);
  console.log(`  ${C.bold}${tally.none} of ${ran}${C.off} behaved identically at both versions.`);
  console.log(`  ${C.dim}minor ${tally.minor} · notable ${tally.notable} · alarming ${tally.alarming}` +
    `${tally.failed ? ` · ${tally.failed} could not be run` : ''}${C.off}`);

  if (interesting.length) {
    console.log(`\n  ${C.bold}What the exceptions actually did${C.off}\n`);
    for (const i of interesting) {
      console.log(`  ${TONE[i.d.severity]}${i.d.severity.toUpperCase().padEnd(9)}${C.off} ${i.pkg} ${C.dim}${i.from} → ${i.to}${C.off}`);
      console.log(`      ${C.dim}${summarise(i.d)}${C.off}`);
      const lines = [
        ...i.d.exec.added.map((e) => `${e.how}: ${e.sample}`),
        ...i.d.env.added.map((e) => `env ${e}`),
        ...i.d.dns.added.map((x) => `dns ${x}`),
        ...i.d.net.added.map((n) => `→ ${n.host}:${n.port}`),
        ...i.d.proc.added.map((p) => `spawn ${p.argv.join(' ')}`),
        ...i.d.fs.added.map((f) => `${f.op} ${f.path}`),
      ];
      lines.slice(0, 6).forEach((l) => console.log(`        ${C.dim}${l}${C.off}`));
      console.log();
    }
  }

  const st = cache.stats();
  console.log(`  ${C.dim}Cache: ${st.hits} free, ${st.writes} learned. Machines left open: ${machines.open}` +
    `${machines.open === 0 ? ` ${C.green}✓${C.off}` : ` ${C.red}← leak${C.off}`}`);
  console.log(`  ${C.dim}Watched with "${strategy}" — Node's API surface only. A native addon goes underneath it.${C.off}\n`);

  machines.cleanup();
}
