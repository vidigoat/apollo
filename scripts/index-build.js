#!/usr/bin/env node
/**
 * Build the behavioural index.
 *
 *   STAKEOUT_ALLOW_LOCAL=1 node scripts/index-build.js --limit 20
 *   node scripts/index-build.js --from-survey        # seed from pairs already surveyed
 *
 * This is the thing that makes every other surface possible. Run a package ONCE, here, and
 * `stakeout lock` in somebody else's repository becomes a lookup rather than a sandbox run. The
 * expensive work happens in one place and the answer is reusable by everyone — which is the only
 * definition of "scale" that means anything for this project.
 *
 * ── Resumable, because it will be interrupted ───────────────────────────────
 *
 * At the target size this runs for hours. It will be killed, the laptop will sleep, a package will
 * hang. So: every entry is written the moment it is known, nothing is held in memory until the end,
 * and a package already in the index is skipped unless `--force`. Stopping and restarting costs
 * only the package that was in flight.
 *
 * ── Which strategy, and why it is recorded ──────────────────────────────────
 *
 * Today this runs `nodert` locally: really installing and importing real packages, watched through
 * Node's own API surface. That is weaker than a kernel tracer — a native addon goes underneath it —
 * and the index records the strategy on every entry so nothing silently overclaims. When Sandboxes
 * beta access arrives, the same builder points at ConTree and entries observed there say so.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * Running strangers' packages executes their install scripts as you. `adapters/local.js` refuses
 * without `STAKEOUT_ALLOW_LOCAL=1` for exactly that reason, and that refusal is deliberate: this
 * project's whole subject is packages doing things you did not expect.
 */

require('../env').loadEnv();

const fs = require('node:fs');
const path = require('node:path');
const { Index, CHANNELS } = require('../index/schema');
const { runPair, runOne } = require('../runPair');
const { bestStrategy } = require('../observe');
const { LocalMachines } = require('../adapters/local');
const { SimulatedSandboxes } = require('../adapters/simulated');
const { PAIRS } = require('./survey');
const { lockfileOnDisk, parseLockfile } = require('../lockfile');

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', amber: '', dim: '', bold: '', off: '' };

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    flags[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return flags;
}

/**
 * Which packages to index, and at which versions.
 *
 * `--from-survey` uses the 82 pairs already verified against the registry by `npm run pairs` —
 * every one real, published, and adjacent in publication order. That is the honest seed: it means
 * the first index is built from a list somebody already checked rather than one we invented.
 */
function work(flags) {
  /*
   * `--from-lockfile <path>` indexes exactly what one repository depends on.
   *
   * This is the product flow rather than a convenience. The survey list is ours, chosen by us, and
   * a developer's answer to "does this cover MY tree" is almost always no. Pointing the builder at
   * their own lockfile means the first thing they index is the thing they actually care about,
   * and every package indexed that way is one more package everyone else gets for free.
   *
   * Single versions here, not pairs: a lockfile pins one version of each package, and what we need
   * to know is what THAT version does. Drift is found later by re-checking, not by guessing which
   * neighbouring version to compare against.
   */
  /*
   * `--from-index <dir>` re-observes what an index already holds — after the probe changes, say.
   * `--with env` narrows it to entries that recorded something on that channel, which is all a fix
   * that only REMOVES misattributed reads can change.
   */
  if (flags['from-index']) {
    const dir = path.resolve(String(flags['from-index']), 'entries');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []));
    const only = flags.with ? String(flags.with) : null;
    const singles = [];
    for (const f of walk(dir)) {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [version, e] of Object.entries(rec.versions || {})) {
        if (only && !(Array.isArray(e[only]) && e[only].length)) continue;
        singles.push({ pkg: rec.name, version, single: true });
      }
    }
    singles.sort((a, b) => `${a.pkg}@${a.version}`.localeCompare(`${b.pkg}@${b.version}`));
    const limit = Number(flags.limit) || 0;
    return limit ? singles.slice(0, limit) : singles;
  }

  if (flags['from-lockfile']) {
    const tree = lockfileOnDisk(flags['from-lockfile'], process.cwd());
    const singles = [...tree.versions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pkg, version]) => ({ pkg, version, single: true }));
    const limit = Number(flags.limit) || 0;
    return limit ? singles.slice(0, limit) : singles;
  }

  /*
   * `--from-fleet <fleet.json>` indexes in the order that buys the most.
   *
   * A lockfile is one project's opinion about what matters, and indexing it in alphabetical order
   * treats a package nobody else depends on exactly like one that appears in sixty projects. A
   * fleet scan already knows the difference: it has read every lockfile on the machine, so it can
   * count how many projects share each package-version and index the most-shared first.
   *
   * That ordering is the whole economics of a central index. The first thousand observations
   * answer far more than the next thousand, and stopping early still leaves the best thousand
   * done — which matters, because a full tree is hours of real installs and almost nobody will run
   * it to completion on the first day.
   *
   * Dependency-versions, not names. An observation of 4.17.21 says nothing about 3.10.1, and
   * ranking by name would pool versions that are not substitutes for one another.
   */
  if (flags['from-fleet']) {
    const fleet = JSON.parse(fs.readFileSync(flags['from-fleet'], 'utf8'));
    const shared = new Map();

    /*
     * Project directories in a scan are relative to its root, so that a scan can be committed
     * without writing somebody's home directory into it. Resolving them is not optional: joining
     * the relative path directly made every lockfile read fail, the ranking came back empty, and
     * the builder reported "0 package-pairs" and exited 0 — a silent no-op that looks like success.
     */
    const root = fleet.root && fleet.root !== '(withheld)' ? fleet.root : null;
    if (!root) {
      console.error('\n  That scan is portable — it has counts and no paths, so there is nothing here to build from.');
      console.error('  Re-run scripts/fleet-scan.js without --portable.\n');
      process.exit(3);
    }

    for (const repo of fleet.repos) {
      if (!repo.dir) continue;
      let versions;
      try {
        ({ versions } = parseLockfile(fs.readFileSync(path.resolve(root, repo.dir, 'package-lock.json'), 'utf8')));
      } catch {
        continue; // already reported as unreadable by the scan
      }
      for (const [pkg, version] of versions) {
        const key = `${pkg}\u0000${version}`;
        shared.set(key, (shared.get(key) || 0) + 1);
      }
    }

    const ranked = [...shared.entries()]
      .map(([key, projects]) => {
        const [pkg, version] = key.split('\u0000');
        return { pkg, version, single: true, projects };
      })
      // Ties broken by name so a resumed build walks the same order as the one it is continuing.
      .sort((a, b) => b.projects - a.projects || a.pkg.localeCompare(b.pkg));

    const limit = Number(flags.limit) || 0;
    return limit ? ranked.slice(0, limit) : ranked;
  }

  const pairs = PAIRS.map(([pkg, from, to]) => ({ pkg, from, to }));
  const limit = Number(flags.limit) || 0;
  return limit ? pairs.slice(0, limit) : pairs;
}

/*
 * Exported so the ordering can be tested without building anything.
 *
 * `work()` decides WHAT to observe and in what order, which is the part with the interesting
 * failure modes — and it is pure, so a test can check it against a fixture tree in milliseconds
 * rather than installing two thousand packages to find out.
 */
module.exports = { work };

/*
 * Guarded, because requiring this file used to start a build. A test that imports it would have
 * hit the STAKEOUT_ALLOW_LOCAL refusal and exited the whole test process — which is why nothing
 * here was tested until now.
 */
if (require.main !== module) return;

(async () => {
  const flags = parseArgs(process.argv.slice(2));
  const index = new Index({ dir: flags.out || undefined });

  const simulated = Boolean(flags.simulated);
  /*
   * `--nebius` observes in Nebius Token Factory Sandboxes: every twin a microVM forked from one
   * checkpoint image, nothing run on this machine — so the refusal below does not apply. Where an
   * entry was observed is recorded on the entry (`observedOn`), because "watched in a disposable
   * microVM" and "watched on somebody's laptop" are different claims about the same transcript.
   */
  const onNebius = Boolean(flags.nebius);
  let adapter;
  if (simulated) adapter = new SimulatedSandboxes();
  else if (onNebius) {
    const { ConTreeSandboxes } = require('../adapters/contree');
    adapter = new ConTreeSandboxes({ image: 'docker.io/library/node:22-slim' });
  } else adapter = new LocalMachines();
  const observedOn = simulated ? null : onNebius ? 'nebius-token-factory-sandboxes' : (process.env.STAKEOUT_OBSERVED_ON || 'local');
  const concurrency = Math.max(1, Math.min(48, Number(flags.concurrency) || (onNebius ? 16 : 1)));

  if (!simulated && !onNebius && process.env.STAKEOUT_ALLOW_LOCAL !== '1') {
    console.error(`\n  ${C.red}Refusing to run.${C.off}`);
    console.error(`  ${C.dim}Building the index installs and imports real packages from the real registry,`);
    console.error(`  as you, with your network and your files. Set STAKEOUT_ALLOW_LOCAL=1 if that is`);
    console.error(`  what you meant — and read adapters/local.js first.`);
    console.error(`  Or pass --simulated to exercise the pipeline without running anything.${C.off}\n`);
    process.exit(3);
  }

  /*
   * `--from N` starts at job N of the ranked list. For a second builder working the far end of the
   * same list into its own `--out` — two processes writing one directory would race on the same
   * package file — and for resuming at a known place.
   */
  const jobs = (work(flags)).slice(Number(flags.from) || 0);
  const strategy = bestStrategy(adapter);

  console.log(`\n  ${C.bold}building the behavioural index${C.off}`);
  console.log(`  ${C.dim}${jobs.length} package-pairs · strategy "${strategy}"${simulated ? ' · SIMULATED' : ''}${onNebius ? ` · Nebius Sandboxes × ${concurrency}` : ''}${C.off}`);
  console.log(`  ${C.dim}${index.summary()}${C.off}\n`);

  // `boot` prepares one healthy machine; every pair forks from that same instant, which is what
  // makes any difference attributable to the package rather than to the machine.
  const checkpoint = await adapter.boot();
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const started = Date.now();

  let done = 0;
  const one = async (job) => {
    const label = job.single ? `${job.pkg}@${job.version}` : `${job.pkg} ${job.from} → ${job.to}`;
    const have = job.single
      ? index.has(job.pkg, job.version)
      : index.has(job.pkg, job.from) && index.has(job.pkg, job.to);

    if (have && !flags.force) {
      skipped++;
      console.log(`  ${C.dim}skip  ${label}${C.off}`);
      return;
    }

    try {
      if (job.single) {
        // runOne, not an inline fork: every branch in this project is released by the same code
        // that took it, and architecture.test.js enforces that.
        const t = await runOne({ adapter, checkpoint, pkg: job.pkg, version: job.version, strategy });
        // The mark travels with the entry, not with the run. See index/schema.js.
        index.put(job.pkg, { ...t, simulated, observedOn });
        indexed++;
        const quiet = CHANNELS.every((c) => !Array.isArray(t[c]) || t[c].length === 0);
        console.log(`  ${quiet ? C.green + 'quiet' : C.amber + 'acts '}${C.off} ${label}`);
      } else {
        const { before, after } = await runPair({ adapter, checkpoint, ...job, strategy });
        // Written immediately. An index that only persists at the end loses everything to one hang.
        index.put(job.pkg, { ...before, simulated, observedOn });
        index.put(job.pkg, { ...after, simulated, observedOn });
        indexed += 2;
        const moved = JSON.stringify(stripVolatile(before)) !== JSON.stringify(stripVolatile(after));
        console.log(`  ${moved ? C.amber + 'moved' : C.green + 'same '}${C.off} ${label}`);
      }
    } catch (e) {
      failed++;
      // One package that will not install must never end the run. It is recorded as absent, which
      // is honest, and `stakeout check` reports absent as "unknown" rather than as clean.
      console.log(`  ${C.red}fail ${C.off} ${label} ${C.dim}${String(e.message).split('\n')[0].slice(0, 70)}${C.off}`);
    }

    if (++done % 10 === 0) index.writeManifest({ note: 'build in progress' });
  };

  // A pool, not a loop: one package at a time is right for a laptop and wasteful for a service
  // that forks 50 microVMs at once. Workers share one Index, and `put` is synchronous per package,
  // so two versions of one package landing together cannot overwrite each other in this process.
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) await one(jobs[next++]);
  }));

  const manifest = index.writeManifest({
    note: simulated ? 'SIMULATED — not a real observation' : `built ${onNebius ? 'in Nebius Token Factory Sandboxes' : 'locally'} with ${strategy}`,
  });

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n  ${C.green}${manifest.packages} packages · ${manifest.versions} versions${C.off}`);
  console.log(`  ${C.dim}${indexed} written, ${skipped} already present, ${failed} failed · ${secs}s${C.off}`);
  console.log(`  ${C.dim}strategies: ${manifest.strategies.join(', ')} · revision ${manifest.revision}${C.off}\n`);

  if (failed) {
    console.log(`  ${C.dim}Failures are absent from the index, not recorded as quiet. \`stakeout check\``);
    console.log(`  reports them as "unknown", which is the honest answer.${C.off}\n`);
  }
})();

/** Timing and pids differ between two runs of the same thing and are not behaviour. */
function stripVolatile(t) {
  const { timing, result, version, observedAt, ...rest } = t;
  return rest;
}
