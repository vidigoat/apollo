#!/usr/bin/env node
/**
 * Stakeout, pointed at a real repository.
 *
 *   STAKEOUT_ALLOW_LOCAL=1 npm run lockfile -- --against HEAD~20
 *   STAKEOUT_ALLOW_LOCAL=1 npm run lockfile -- --against v2.3.0 --repo ~/some/project
 *   npm run lockfile -- --against HEAD~20 --dry-run        # just say what moved
 *
 * Everything else in this project runs against a fixture. This reads an actual `package-lock.json`,
 * compares it to the same file at an earlier commit, and runs the packages that actually moved —
 * which is the question the whole thing exists to answer, asked about real software:
 *
 *   between these two commits, which of my dependencies changed, and what do those changes DO?
 *
 * `--dry-run` needs nothing at all and is worth running first: it answers "how much of this upgrade
 * is even worth looking at", usually with a much smaller number than anybody expects.
 *
 * Running for real executes those packages on this machine. Read adapters/local.js first.
 */

const path = require('node:path');
const { whatMoved, lockfileAtRevision, lockfileOnDisk } = require('../lockfile');
const { diff, summarise } = require('../differ/diff');
const { judgeOne } = require('../judge');
const { lookUp } = require('../evidence/tavily');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };
const TONE = { alarming: C.red, notable: C.amber, minor: C.dim, none: C.dim };

function parseArgs(argv) {
  const a = { against: null, repo: process.cwd(), file: 'package-lock.json', dryRun: false, limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--against': a.against = v; i++; break;
      case '--repo': a.repo = path.resolve(v.replace(/^~/, process.env.HOME || '~')); i++; break;
      case '--file': a.file = v; i++; break;
      case '--limit': a.limit = Number(v) || 25; i++; break;
      case '--dry-run': a.dryRun = true; break;
    }
  }
  return a;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.against) {
    console.error(`
  ${C.bold}Which commit should I compare against?${C.off}

    npm run lockfile -- --against HEAD~20 --dry-run
    STAKEOUT_ALLOW_LOCAL=1 npm run lockfile -- --against v2.3.0 --repo ~/my-project

  ${C.dim}--dry-run needs nothing and answers "how much of this upgrade is worth looking at".${C.off}
`);
    process.exit(1);
  }

  console.log(`\n  ${C.bold}STAKEOUT${C.off}  ${C.dim}${args.repo}${C.off}`);

  let before;
  let after;
  try {
    after = lockfileOnDisk(args.file, args.repo);
    before = await lockfileAtRevision(args.against, args.file, args.repo);
  } catch (e) {
    console.error(`\n  ${C.red}${e.message}${C.off}\n`);
    process.exit(1);
  }

  const d = whatMoved(before, after);

  console.log(`\n  ${args.against} ${C.dim}→${C.off} working tree   ${C.dim}(lockfile ${before.format} → ${after.format})${C.off}`);
  console.log(`  ${d.total.toLocaleString()} packages · ${C.bold}${d.moved.length} moved${C.off} · ${d.added.length} added · ${d.removed.length} removed · ${d.unchanged.toLocaleString()} untouched`);

  if (d.added.length) {
    console.log(`  ${C.dim}An added package has no previous version to compare against, so it is counted and not run.${C.off}`);
  }
  if (after.conflicts.length) {
    console.log(`  ${C.amber}${after.conflicts.length} package(s) present at more than one version:${C.off} ${C.dim}${after.conflicts.slice(0, 4).map((c) => `${c.name} (${c.versions.join(', ')})`).join('; ')}${C.off}`);
  }

  if (!d.moved.length) {
    console.log(`\n  ${C.green}Nothing moved.${C.off} There is nothing here to watch.\n`);
    return;
  }

  const jobs = d.moved.slice(0, args.limit);
  if (d.moved.length > jobs.length) {
    console.log(`  ${C.dim}Running the first ${jobs.length}; --limit ${d.moved.length} for all of them.${C.off}`);
  }

  if (args.dryRun) {
    console.log(`\n  ${C.dim}--dry-run: what moved, without running anything.${C.off}\n`);
    jobs.forEach((m) => console.log(`    ${m.pkg.padEnd(38)} ${C.dim}${m.from} → ${m.to}${C.off}`));
    console.log(`\n  ${C.dim}Drop --dry-run (with STAKEOUT_ALLOW_LOCAL=1) to find out what they do.${C.off}\n`);
    return;
  }

  // Only now do we need the machinery that executes other people's code.
  const { LocalMachines } = require('../adapters/local');
  const { observePackage, bestStrategy } = require('../observe');

  let machines;
  try {
    machines = new LocalMachines();
  } catch (e) {
    console.error(`\n  ${C.red}${e.message}${C.off}\n`);
    process.exit(1);
  }

  const strategy = bestStrategy(machines);
  console.log(`\n  ${C.dim}Watching with "${strategy}". Two twins per package, from one prepared directory.${C.off}\n`);

  const checkpoint = await machines.boot();
  const findings = [];
  let quiet = 0;

  for (const m of jobs) {
    process.stdout.write(`  ${m.pkg.padEnd(38)} ${C.dim}${m.from} → ${m.to}${C.off}  `);
    const [a, b] = await machines.fork(checkpoint, 2);
    try {
      const [oldT, newT] = await Promise.all([
        observePackage({ adapter: machines, branch: a, pkg: m.pkg, version: m.from, strategy }),
        observePackage({ adapter: machines, branch: b, pkg: m.pkg, version: m.to, strategy }),
      ]);
      const result = diff(oldT, newT);
      console.log(`${TONE[result.severity]}${result.severity}${C.off}`);
      if (!result.changed) { quiet++; continue; }

      console.log(`      ${C.dim}${summarise(result)}${C.off}`);
      const record = await lookUp(m.pkg, m.to);
      const j = await judgeOne(result, record);
      if (j.verdict) console.log(`      ${C.dim}nemotron:${C.off} ${j.verdict.meaning}`);
      console.log(`      ${C.dim}web:${C.off} ${record.verdict}`);
      console.log(`      ${C.dim}call:${C.off} ${j.accused ? C.red + j.reason + C.off : j.reason}`);
      findings.push({ ...m, severity: result.severity, accused: j.accused });
    } catch (e) {
      // One package failing to install is a fact about that package, not the end of the run.
      console.log(`${C.amber}could not run${C.off}\n      ${C.dim}${e.message}${C.off}`);
    } finally {
      await machines.discard(a);
      await machines.discard(b);
    }
  }

  console.log(`\n  ${C.dim}${'─'.repeat(70)}${C.off}`);
  console.log(`  ${quiet} of ${jobs.length} behaved identically at both versions.`);
  const accused = findings.filter((f) => f.accused);
  console.log(`  ${C.bold}Accused: ${accused.length ? C.red + accused.map((f) => f.pkg).join(', ') + C.off : 'nothing'}${C.off}`);
  console.log(`  ${C.dim}Machines left open: ${machines.open}${machines.open === 0 ? ` ${C.green}✓${C.off}` : ` ${C.red}← leak${C.off}`}`);
  console.log(`  ${C.dim}Watched with "${strategy}" — Node's API surface only. A native addon goes underneath it.${C.off}\n`);

  machines.cleanup();
})();
