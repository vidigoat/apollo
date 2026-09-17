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
const { bestStrategy } = require('../observe');
const { runPair } = require('../runPair');
const { summarise } = require('../differ/diff');
const { BehaviourCache } = require('../cache');

/**
 * Real packages, real consecutive-ish versions, chosen for ubiquity rather than for interest.
 * Between them these sit under a very large share of the JavaScript ecosystem.
 */
const PAIRS = [
  ['left-pad', '1.2.0', '1.3.0'],
  ['ms', '2.1.2', '2.1.3'],
  ['picocolors', '1.0.0', '1.1.1'],
  ['debug', '4.3.4', '4.4.0'],
  ['chalk', '5.3.0', '5.4.1'],
  ['semver', '7.5.4', '7.6.3'],
  ['uuid', '9.0.0', '9.0.1'],
  ['dotenv', '16.3.1', '16.4.7'],
  ['nanoid', '4.0.2', '5.0.9'],
  ['yallist', '4.0.0', '5.0.0'],
  ['lru-cache', '10.0.0', '10.4.3'],
  ['mime-types', '2.1.34', '2.1.35'],
  ['escape-string-regexp', '4.0.0', '5.0.0'],
  ['strip-ansi', '7.0.1', '7.1.0'],
  ['ansi-regex', '6.0.1', '6.1.0'],
  ['is-glob', '4.0.1', '4.0.3'],
  ['path-to-regexp', '6.2.1', '6.3.0'],
  ['tslib', '2.6.0', '2.8.1'],
  ['ejs', '3.1.9', '3.1.10'],
  ['minimatch', '9.0.0', '9.0.5'],
  // A second twenty, added to make the baseline harder to dismiss. Same rule: chosen for being
  // depended upon, never for being interesting.
  ['clsx', '1.2.1', '2.1.1'],
  ['yocto-queue', '1.0.0', '1.1.1'],
  ['eventemitter3', '4.0.7', '5.0.1'],
  ['object-assign', '4.1.0', '4.1.1'],
  ['safe-buffer', '5.1.2', '5.2.1'],
  ['side-channel', '1.0.4', '1.0.6'],
  ['has-flag', '3.0.0', '4.0.0'],
  ['color-name', '1.1.3', '1.1.4'],
  ['wrappy', '1.0.1', '1.0.2'],
  ['inherits', '2.0.3', '2.0.4'],
  ['isexe', '2.0.0', '3.1.1'],
  ['balanced-match', '1.0.0', '1.0.2'],
  ['brace-expansion', '2.0.0', '2.0.1'],
  ['emoji-regex', '9.2.0', '9.2.2'],
  ['is-number', '7.0.0', '7.0.0'],
  ['queue-microtask', '1.2.2', '1.2.3'],
  ['reusify', '1.0.2', '1.0.4'],
  ['run-parallel', '1.1.10', '1.2.0'],
  ['to-regex-range', '5.0.0', '5.0.1'],
  ['fastq', '1.13.0', '1.17.1'],
];

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
