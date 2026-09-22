#!/usr/bin/env node
/**
 * The behavioural index, as one file anybody can fetch.
 *
 *   npm run index:publish
 *
 * ── Why this is the missing piece ───────────────────────────────────────────
 *
 * The whole argument of this project is a ratio: a package's behaviour does not depend on who
 * imported it, so it is observed ONCE and looked up after that, and the hundredth repository that
 * depends on it is free.
 *
 * That argument has been unverifiable. The index is built locally and gitignored, so a reader who
 * wanted to check the claim had to install two thousand packages first. "Run a package once and
 * answer for every repository" is a sentence about an artefact that did not exist anywhere a
 * stranger could reach it — which makes it a description of a plan rather than of a thing.
 *
 * This writes the artefact. `public/index.json`, about half a megabyte, sixty kilobytes over the
 * wire, and after that:
 *
 *     git clone https://github.com/vidigoat/cassandra ~/stakeout
 *     cd ~/your-project
 *     node ~/stakeout/cli.js lock --index https://cassandra-nu.vercel.app/index.json
 *
 * runs in somebody else's repository against real observations, and either their tree is answered
 * or it is not. The claim becomes a thing that can be wrong.
 *
 * ── Two things it refuses to publish ────────────────────────────────────────
 *
 * A simulated observation, and a strategy's stale idea of what it could see. Both are covered
 * below, and both would be invisible to anyone reading the file.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { Index, SCHEMA, DEFAULT_DIR } = require('../index/schema');
const { CAN_SEE } = require('../transcript/schema');

const ROOT = path.join(__dirname, '..');

/**
 * Where to write. `--out <path>` exists because a test needed it.
 *
 * `index/published.test.js` proves the publisher refuses a simulated entry by pointing
 * STAKEOUT_INDEX at a temporary index and running this — and with a hard-coded destination that
 * run replaced the repository's real, committed `public/index.json` with a one-package test file.
 * Nothing failed. It was caught by `check-readme`, which noticed the README now claimed 1,589
 * packages for an artefact holding one, and it would otherwise have been deployed.
 */
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > -1 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(ROOT, 'public', 'index.json');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };

function main() {
  const index = new Index();
  const manifest = index.manifest();
  if (!manifest) {
    console.error(`\n  ${C.red}No index to publish.${C.off}  Build one with \`npm run index:build\`.\n`);
    process.exit(1);
  }

  const entriesDir = path.join(DEFAULT_DIR, 'entries');
  const packages = {};
  let versions = 0;
  const refused = [];
  const strategies = new Set();

  for (const shard of fs.readdirSync(entriesDir)) {
    const at = path.join(entriesDir, shard);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const file of fs.readdirSync(at)) {
      if (!file.endsWith('.json')) continue;
      const name = JSON.parse(fs.readFileSync(path.join(at, file), 'utf8')).name;

      /*
       * Read back THROUGH the Index, not off the disk.
       *
       * `Index.package` restates each entry's `canSee` from the strategy table, and that is not a
       * formality here. Every entry in this index was written while `nodert` was recorded as
       * `fs: true`; it is not, the probe hooks writes only, and a file read by a package is
       * invisible to it. Publishing the raw entries would put two thousand copies of a corrected
       * overclaim on a public URL, where they would outlive the correction.
       */
      const record = index.package(name);
      if (!record) continue;

      const keep = {};
      for (const [version, entry] of Object.entries(record.versions || {})) {
        /*
         * A simulated observation never leaves this machine.
         *
         * The index already refuses to mix them — it happened once, 8,623 fabricated entries over
         * 705 real ones — but that rule guards a directory. This file is the one a stranger runs
         * `check` against, and a fabricated entry in it is a fabricated answer about their code.
         */
        if (entry.simulated || entry.strategy === 'simulated') {
          refused.push(`${name}@${version} (simulated)`);
          continue;
        }
        if (!CAN_SEE[entry.strategy]) {
          refused.push(`${name}@${version} (strategy "${entry.strategy}" is not one this build defines)`);
          continue;
        }
        strategies.add(entry.strategy);
        keep[version] = entry;
        versions++;
      }
      if (Object.keys(keep).length) packages[name] = keep;
    }
  }

  const artefact = {
    schema: SCHEMA,
    /*
     * What the reader needs in order to disbelieve this file.
     *
     * Not decoration: `canSee` is the table every claim is weighed against, so it travels WITH the
     * index rather than being something the reader has to go and find. An index that says what it
     * watched can be argued with. One that does not can only be trusted.
     */
    revision: manifest.revision,
    generatedAt: new Date().toISOString(),
    strategies: [...strategies].sort(),
    canSee: Object.fromEntries([...strategies].sort().map((s) => [s, CAN_SEE[s]])),
    counts: { packages: Object.keys(packages).length, versions },
    note:
      'Every entry is one real installation of one real package-version, watched by the strategy ' +
      'named on it. A package-version that is not in here was never observed — which is not the ' +
      'same as observed and quiet, and `stakeout check` reports it as its own outcome.',
    packages,
  };

  const json = JSON.stringify(artefact);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);

  const gz = zlib.gzipSync(json).length;
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  console.log(`\n  ${C.bold}THE INDEX, AS ONE FILE${C.off}`);
  console.log(`  ${C.dim}public/index.json — what the demo URL serves, and what \`check --index\` reads${C.off}\n`);
  console.log(`  ${C.dim}revision${C.off}    ${artefact.revision}`);
  console.log(`  ${C.dim}packages${C.off}    ${artefact.counts.packages.toLocaleString()}`);
  console.log(`  ${C.dim}versions${C.off}    ${artefact.counts.versions.toLocaleString()}`);
  console.log(`  ${C.dim}strategy${C.off}    ${artefact.strategies.join(', ')}`);
  for (const [s, row] of Object.entries(artefact.canSee)) {
    const partial = Object.entries(row).filter(([, v]) => v !== true);
    console.log(
      `  ${C.dim}can see${C.off}     ${s}: ` +
        (partial.length
          ? `${C.amber}${partial.map(([k, v]) => (v === false ? `no ${k}` : `${k} (${v} only)`)).join(', ')}${C.off}`
          : `${C.green}every channel${C.off}`)
    );
  }
  console.log(`  ${C.dim}size${C.off}        ${mb(json.length)}, ${mb(gz)} gzipped\n`);

  if (refused.length) {
    console.log(`  ${C.amber}${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} not published${C.off}`);
    for (const r of refused.slice(0, 8)) console.log(`    ${C.dim}${r}${C.off}`);
    if (refused.length > 8) console.log(`    ${C.dim}…and ${refused.length - 8} more${C.off}`);
    console.log();
  }

  /*
   * The whole command, including the clone.
   *
   * It printed `npx github:vidigoat/cassandra`, which is a command that does not work: the
   * repository is private until submission, and npx on a private repo fails with a git error that
   * says nothing about why. A printed command is a promise, and one that only works after something
   * else has happened is a promise broken the first time somebody tries it.
   */
  console.log(`  ${C.dim}Anybody, in their own repository:${C.off}`);
  console.log('    git clone https://github.com/vidigoat/cassandra ~/stakeout');
  console.log('    cd ~/your-project');
  console.log('    node ~/stakeout/cli.js lock --index https://cassandra-nu.vercel.app/index.json\n');
}

if (require.main === module) main();

module.exports = { OUT };
