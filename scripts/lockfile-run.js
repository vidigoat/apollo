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
const { BehaviourCache } = require('../cache');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };
const TONE = { alarming: C.red, notable: C.amber, minor: C.dim, none: C.dim };

function parseArgs(argv) {
  const a = { against: null, repo: process.cwd(), file: 'package-lock.json', dryRun: false, limit: 25, cache: true, json: false, failOn: 'alarming' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--against': a.against = v; i++; break;
      case '--repo': a.repo = path.resolve(v.replace(/^~/, process.env.HOME || '~')); i++; break;
      case '--file': a.file = v; i++; break;
      case '--limit': a.limit = Number(v) || 25; i++; break;
      case '--dry-run': a.dryRun = true; break;
      case '--no-cache': a.cache = false; break;
      case '--json': a.json = true; break;
      case '--fail-on': a.failOn = v; i++; break;
    }
  }
  return a;
}

/**
 * Severity as a number, so `--fail-on notable` can mean "and anything worse".
 * A build that only fails on the very worst thing is a build nobody trusts to catch the rest.
 */
const RANK = { none: 0, minor: 1, notable: 2, alarming: 3 };

(async () => {
  const args = parseArgs(process.argv.slice(2));
  // In --json mode the only thing on stdout is the JSON document. A pipeline consuming this should
  // not have to strip a banner out of it, and a half-parsed report is worse than a missing one.
  const out = args.json ? () => {} : (...a) => console.log(...a);
  if (!args.against) {
    console.error(`
  ${C.bold}Which commit should I compare against?${C.off}

    npm run lockfile -- --against HEAD~20 --dry-run
    STAKEOUT_ALLOW_LOCAL=1 npm run lockfile -- --against v2.3.0 --repo ~/my-project

  ${C.dim}--dry-run needs nothing and answers "how much of this upgrade is worth looking at".${C.off}
`);
    process.exit(1);
  }

  out(`\n  ${C.bold}STAKEOUT${C.off}  ${C.dim}${args.repo}${C.off}`);

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

  out(`\n  ${args.against} ${C.dim}→${C.off} working tree   ${C.dim}(lockfile ${before.format} → ${after.format})${C.off}`);
  out(`  ${d.total.toLocaleString()} packages · ${C.bold}${d.moved.length} moved${C.off} · ${d.added.length} added · ${d.removed.length} removed · ${d.unchanged.toLocaleString()} untouched`);

  if (d.added.length) {
    out(`  ${C.dim}An added package has no previous version to compare against, so it is counted and not run.${C.off}`);
  }
  if (after.conflicts.length) {
    out(`  ${C.amber}${after.conflicts.length} package(s) present at more than one version:${C.off} ${C.dim}${after.conflicts.slice(0, 4).map((c) => `${c.name} (${c.versions.join(', ')})`).join('; ')}${C.off}`);
  }

  if (!d.moved.length) {
    if (args.json) console.log(JSON.stringify({ repo: args.repo, against: args.against, tree: d.total, moved: [], added: d.added.length, removed: d.removed.length, findings: [], worst: 'none' }, null, 2));
    else out(`\n  ${C.green}Nothing moved.${C.off} There is nothing here to watch.\n`);
    return;
  }

  const jobs = d.moved.slice(0, args.limit);
  if (d.moved.length > jobs.length) {
    out(`  ${C.dim}Running the first ${jobs.length}; --limit ${d.moved.length} for all of them.${C.off}`);
  }

  if (args.dryRun) {
    if (args.json) {
      console.log(JSON.stringify({ repo: args.repo, against: args.against, tree: d.total, moved: d.moved, added: d.added.length, removed: d.removed.length, dryRun: true }, null, 2));
      return;
    }
    out(`\n  ${C.dim}--dry-run: what moved, without running anything.${C.off}\n`);
    jobs.forEach((m) => out(`    ${m.pkg.padEnd(38)} ${C.dim}${m.from} → ${m.to}${C.off}`));
    out(`\n  ${C.dim}Drop --dry-run (with STAKEOUT_ALLOW_LOCAL=1) to find out what they do.${C.off}\n`);
    return;
  }

  // Only now do we need the machinery that executes other people's code.
  const { LocalMachines } = require('../adapters/local');
  const { bestStrategy } = require('../observe');
  const { runPair } = require('../runPair');

  let machines;
  try {
    machines = new LocalMachines();
  } catch (e) {
    console.error(`\n  ${C.red}${e.message}${C.off}\n`);
    process.exit(1);
  }

  const strategy = bestStrategy(machines);
  const cache = new BehaviourCache({ enabled: args.cache });
  out(`\n  ${C.dim}Watching with "${strategy}". Two twins per package, from one prepared directory.${C.off}\n`);

  const checkpoint = await machines.boot();
  const findings = [];
  let quiet = 0;

  for (const m of jobs) {
    if (!args.json) process.stdout.write(`  ${m.pkg.padEnd(38)} ${C.dim}${m.from} → ${m.to}${C.off}  `);

    // What a version pair did, it did. Asked again — next week, on another branch, in another
    // repository — the answer is free. The strategy is part of the key, so a cached answer is
    // never served to a question it could not have answered.
    const job = { pkg: m.pkg, from: m.from, to: m.to, strategy };
    const remembered = cache.get(job);
    if (remembered) {
      out(`${TONE[remembered.severity]}${remembered.severity}${C.off} ${C.dim}· from cache${C.off}`);
      if (!remembered.changed) { quiet++; continue; }
      out(`      ${C.dim}${summarise(remembered)}${C.off}`);
      findings.push({ ...m, severity: remembered.severity, accused: false, cached: true });
      continue;
    }

    try {
      // Through runPair: one checkpoint for both twins, branches always released, both tested.
      const { diff: result } = await runPair({
        adapter: machines, checkpoint, pkg: m.pkg, from: m.from, to: m.to, strategy,
      });
      cache.put(job, result);
      out(`${TONE[result.severity]}${result.severity}${C.off}`);
      if (!result.changed) { quiet++; continue; }

      out(`      ${C.dim}${summarise(result)}${C.off}`);
      const record = await lookUp(m.pkg, m.to);
      const j = await judgeOne(result, record);
      if (j.verdict) out(`      ${C.dim}nemotron:${C.off} ${j.verdict.meaning}`);
      out(`      ${C.dim}web:${C.off} ${record.verdict}`);
      out(`      ${C.dim}call:${C.off} ${j.accused ? C.red + j.reason + C.off : j.reason}`);
      findings.push({ ...m, severity: result.severity, accused: j.accused });
    } catch (e) {
      // One package failing to install is a fact about that package, not the end of the run.
      out(`${C.amber}could not run${C.off}\n      ${C.dim}${e.message}${C.off}`);
    }
  }

  out(`\n  ${C.dim}${'─'.repeat(70)}${C.off}`);
  out(`  ${quiet} of ${jobs.length} behaved identically at both versions.`);
  const accused = findings.filter((f) => f.accused);
  out(`  ${C.bold}Accused: ${accused.length ? C.red + accused.map((f) => f.pkg).join(', ') + C.off : 'nothing'}${C.off}`);
  const st = cache.stats();
  if (args.cache) {
    out(`  ${C.dim}Cache: ${st.hits} answered without running, ${st.writes} learned. ${st.dir}${C.off}`);
  }
  out(`  ${C.dim}Machines left open: ${machines.open}${machines.open === 0 ? ` ${C.green}✓${C.off}` : ` ${C.red}← leak${C.off}`}`);
  out(`  ${C.dim}Watched with "${strategy}" — Node's API surface only. A native addon goes underneath it.${C.off}\n`);

  machines.cleanup();

  /* ── the part a pipeline reads ──────────────────────────────────────────
   * Exit code, so this can gate a merge. Default is `alarming` only: a build that fails on every
   * minor cache-file change is a build people switch off, and a check nobody runs protects nothing.
   */
  const worst = findings.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), 'none');

  if (args.json) {
    console.log(JSON.stringify({
      repo: args.repo,
      against: args.against,
      strategy,
      tree: d.total,
      moved: d.moved.length,
      added: d.added.length,
      removed: d.removed.length,
      ran: jobs.length,
      quiet,
      // Every strategy is blind to something, and a machine reading this needs that as much as a
      // person does — otherwise an empty findings list reads as "clean" rather than "not looked at".
      cannotSee: Object.entries(require('../transcript/schema').CAN_SEE[strategy])
        .filter(([, v]) => !v).map(([k]) => k),
      cache: cache.stats(),
      worst,
      failOn: args.failOn,
      findings,
    }, null, 2));
  }

  if (RANK[worst] >= (RANK[args.failOn] ?? RANK.alarming)) {
    out(`\n  ${C.red}Exiting non-zero: worst severity "${worst}" meets --fail-on "${args.failOn}".${C.off}\n`);
    process.exitCode = 1;
  }
})();
