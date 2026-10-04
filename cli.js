#!/usr/bin/env node
/**
 * stakeout — the command line.
 *
 *   stakeout lock            walk package-lock.json, resolve every package against the index,
 *                            write stakeout.lock. Commit it.
 *   stakeout check           re-resolve and diff against the committed lock. Non-zero on drift.
 *   stakeout explain <pkg>   what this package does, and which run observed it.
 *   stakeout index           what the index currently holds.
 *
 * ── Why a CLI at all ────────────────────────────────────────────────────────
 *
 * Everything else in this repository operated on a fixture. This is the first piece a developer can
 * point at their own project, and it is deliberately the piece that needs the least: no Sandboxes,
 * no hosting, no account, no key. It reads a lockfile and an index and exits with a number.
 *
 * ── Exit codes are the interface ────────────────────────────────────────────
 *
 * This runs in CI, where nobody reads the output until something fails. The exit code IS the
 * product.
 *
 *   0   clean — every package in the tree matched what the lock recorded
 *   1   drift — at least one package now behaves differently. This is the finding.
 *   2   unknown — packages the index has never seen, and --fail-on-unknown was set
 *   3   usage or environment error, distinct from a finding so CI can tell them apart
 *
 * 3 exists because a broken run and a real finding must never look the same to a pipeline. A tool
 * that exits 1 when it cannot find its own config teaches people to ignore exit 1.
 */

require('./env').loadEnv();

const fs = require('node:fs');
const path = require('node:path');
const { Index } = require('./index/schema');
const { open } = require('./index/published');
const { lockfileOnDisk, lockfileAtRevision, whatMoved, installsOnLinux } = require('./lockfile');
const { bumpReport, readable } = require('./github/bump');
const { buildLock, checkLock, writeLock, readLock, DEFAULT_FILE } = require('./lock');
const { CHANNELS } = require('./index/schema');

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', amber: '', dim: '', bold: '', off: '' };

const EXIT = { clean: 0, drift: 1, unknown: 2, usage: 3 };

const die = (msg, hint) => {
  console.error(`\n  ${C.red}${msg}${C.off}`);
  if (hint) console.error(`  ${C.dim}${hint}${C.off}`);
  console.error('');
  process.exit(EXIT.usage);
};

/** Flags, parsed the boring way. No dependency, and no surprises. */
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, inline] = a.slice(2).split('=');
    flags[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return { flags, rest };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One channel entry, rendered the way it appears everywhere else in this project. */
function renderItem(channel, item) {
  if (typeof item === 'string') return item;
  if (channel === 'net') return `${item.host}:${item.port ?? ''}${item.proto ? '/' + item.proto : ''}`;
  if (channel === 'fs') return `${item.op} ${item.path}`;
  if (channel === 'proc') return (item.argv || []).join(' ');
  if (channel === 'exec') return `${item.how} ${item.sample ?? ''}`.trim();
  return JSON.stringify(item);
}

/* ── stakeout lock ──────────────────────────────────────────────────────── */

async function cmdLock({ flags }) {
  const index = await openIndex(flags);

  let tree;
  try {
    tree = lockfileOnDisk(flags.lockfile || 'package-lock.json');
  } catch (e) {
    die(e.message, 'Run this from a directory with a package-lock.json, or pass --lockfile <path>.');
  }

  const { lock, known, unknown } = buildLock(tree.versions, index);
  const out = flags.out || DEFAULT_FILE;

  if (flags['dry-run']) {
    console.log(`\n  ${C.bold}${out}${C.off} ${C.dim}(dry run — nothing written)${C.off}`);
  } else {
    writeLock(lock, out);
    console.log(`\n  ${C.green}wrote${C.off} ${C.bold}${out}${C.off}`);
  }

  console.log(`  ${C.dim}${plural(known, 'package')} pinned from ${index.summary()}${C.off}`);

  if (unknown.length) {
    /*
     * Said loudly, and listed in the file.
     *
     * A lock that quietly omitted what it could not resolve would look complete and be incomplete,
     * which is the worst state a security artefact can be in.
     */
    console.log(`  ${C.amber}${plural(unknown.length, 'package')} the index has never seen${C.off}`);
    for (const u of unknown.slice(0, 8)) console.log(`      ${C.dim}${u}${C.off}`);
    if (unknown.length > 8) console.log(`      ${C.dim}… and ${unknown.length - 8} more, all listed in ${out}${C.off}`);
    const elsewhere = unknown.filter((id) => tree.platforms?.has(id) && !installsOnLinux(tree.platforms.get(id)));
    if (elsewhere.length) {
      console.log(`  ${C.dim}${elsewhere.length} of them ${elsewhere.length === 1 ? 'is' : 'are'} built only for another platform (macOS, Windows, musl), so not installable where the index is observed.${C.off}`);
    }
    console.log(`  ${C.dim}They are recorded under "unknown" — the lock does not pretend to cover them.${C.off}`);
  }
  console.log('');
  return EXIT.clean;
}


/**
 * The index this run will use: the one on this machine, or one somebody published.
 *
 * ── Why `--index <url>` exists ──────────────────────────────────────────────
 *
 * Until it did, using this tool meant building an index first — installing a couple of thousand
 * packages in sandboxes before the first question could be answered. That is a fine thing to be
 * able to do and a terrible thing to require, and it made the project's central claim unverifiable
 * by anyone who had not already spent an afternoon on it: run a package once, answer for every
 * repository that depends on it. Once is the point. Once, by somebody.
 *
 *     stakeout check --index https://cassandra-nu.vercel.app/index.json
 *
 * reads a published index — 1,589 packages, sixty kilobytes over the wire — and answers about YOUR
 * tree. Most of it will come back unknown, because most of npm has not been watched by anybody.
 * That is the honest state of the world and `check` reports it as its own outcome rather than as a
 * pass.
 */
async function openIndex(flags) {
  const where = flags.index === true ? null : flags.index;
  if (!where) {
    const index = new Index();
    if (!index.manifest()) {
      die(
        'No index found.',
        'Build one with `npm run index:build`, point STAKEOUT_INDEX at one,\n' +
          '  or use a published one:\n\n' +
          '    stakeout check --index https://cassandra-nu.vercel.app/index.json'
      );
    }
    return index;
  }

  try {
    const index = await open(where);
    /*
     * A published index carries the table it was written with. If this build disagrees about what a
     * strategy can see, the reader is told — silently applying the local interpretation to somebody
     * else's recording is how an overclaim travels between machines.
     */
    const differs = index.mismatch();
    if (differs.length) {
      console.error(`\n  ${C.amber}That index was published by a build that describes its strategies differently:${C.off}`);
      for (const line of differs) console.error(`    ${C.dim}${line}${C.off}`);
      console.error(`  ${C.dim}Entries are read with THIS build's table, because that is what interprets them.${C.off}`);
    }
    return index;
  } catch (e) {
    die(`Could not read the index at ${where}.`, e.message);
  }
  return null;
}

/* ── stakeout check ─────────────────────────────────────────────────────── */

async function cmdCheck({ flags }) {
  const index = await openIndex(flags);

  let lock;
  try {
    lock = readLock(flags.lock || DEFAULT_FILE);
  } catch (e) {
    die(e.message);
  }
  if (!lock) {
    die(`No ${flags.lock || DEFAULT_FILE} to check against.`, 'Run `stakeout lock` first and commit the result.');
  }

  let tree;
  try {
    tree = lockfileOnDisk(flags.lockfile || 'package-lock.json');
  } catch (e) {
    die(e.message);
  }

  const result = checkLock(lock, tree.versions, index);

  console.log(`\n  ${C.bold}stakeout check${C.off} ${C.dim}· ${plural(result.checked, 'package')} checked against ${lock.index?.revision ?? 'an unknown index'}${C.off}`);

  if (result.drift.length) {
    console.log(`\n  ${C.red}${plural(result.drift.length, 'package')} behaves differently than the lock records${C.off}\n`);
    for (const d of result.drift) {
      console.log(`  ${C.bold}${d.package}${C.off}`);
      for (const ch of d.changes) {
        const gone = (ch.before || []).filter((b) => !(ch.after || []).some((a) => JSON.stringify(a) === JSON.stringify(b)));
        const came = (ch.after || []).filter((a) => !(ch.before || []).some((b) => JSON.stringify(b) === JSON.stringify(a)));
        for (const item of came) console.log(`      ${C.red}+ ${ch.channel.padEnd(5)} ${renderItem(ch.channel, item)}${C.off}`);
        for (const item of gone) console.log(`      ${C.dim}- ${ch.channel.padEnd(5)} ${renderItem(ch.channel, item)}${C.off}`);
      }
      console.log('');
    }
  }

  if (result.added.length) {
    console.log(`  ${C.dim}${plural(result.added.length, 'package')} added since the lock was written — not drift, there is nothing to have drifted from:${C.off}`);
    for (const a of result.added.slice(0, 5)) console.log(`      ${C.dim}${a}${C.off}`);
    if (result.added.length > 5) console.log(`      ${C.dim}… and ${result.added.length - 5} more${C.off}`);
    console.log(`  ${C.dim}Re-run \`stakeout lock\` to pin them.${C.off}\n`);
  }

  if (result.unknown.length) {
    console.log(`  ${C.amber}${plural(result.unknown.length, 'package')} the index has never seen${C.off}`);
    console.log(`  ${C.dim}Not a pass and not a failure — an honest "I do not know".${C.off}\n`);
  }

  if (result.clean && !result.unknown.length) {
    console.log(`  ${C.green}clean${C.off} ${C.dim}— every package does exactly what the lock says it does${C.off}\n`);
    return EXIT.clean;
  }

  if (result.drift.length) return EXIT.drift;
  if (result.unknown.length && flags['fail-on-unknown']) return EXIT.unknown;

  console.log(`  ${C.green}no drift${C.off}\n`);
  return EXIT.clean;
}

/* ── stakeout upgrade ───────────────────────────────────────────────────── */

/*
 * What a version bump DOES — the pull request a dependency bot opens, checked from a terminal.
 *
 * `check` asks whether a version that did not move still behaves as the lock records. This asks the
 * other question: the lockfile on disk moved some versions since a commit (the branch you are about
 * to merge into) — does each new release behave like the one it replaces? It runs nothing. The
 * answer comes from the live watch (that exact pair, run old-against-new when the release was
 * published) and, failing that, from two entries in the index.
 *
 * It is the GitHub App's answer without the App: one line in any CI, on any forge.
 */
async function openWatched(flags) {
  const where = typeof flags.watched === 'string' ? flags.watched
    : typeof flags.index === 'string' && /^https?:/.test(flags.index) ? new URL('watched-releases.json', flags.index).href
      : path.join(__dirname, 'public', 'watched-releases.json');
  try {
    if (/^https?:/.test(where)) {
      const res = await fetch(where, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${res.status}`);
      return { ledger: await res.json(), where };
    }
    return { ledger: JSON.parse(fs.readFileSync(where, 'utf8')), where };
  } catch {
    return { ledger: null, where };
  }
}

async function cmdUpgrade({ flags }) {
  const index = await openIndex(flags);
  const against = typeof flags.against === 'string' ? flags.against : 'HEAD';
  const file = flags.lockfile || 'package-lock.json';

  let before;
  let after;
  try {
    before = await lockfileAtRevision(against, file);
    after = lockfileOnDisk(file);
  } catch (e) {
    die(e.message);
  }
  const { moved } = whatMoved(before, after);
  const { ledger, where } = await openWatched(flags);

  console.log(`\n  ${C.bold}stakeout upgrade${C.off} ${C.dim}· ${plural(moved.length, 'version')} moved since ${against}${ledger ? ` · ${ledger.count ?? '?'} watched release pairs` : ` · no watched releases at ${where}`}${C.off}`);
  if (!moved.length) {
    console.log(`\n  ${C.dim}Nothing was upgraded, so there is nothing to compare.${C.off}\n`);
    return EXIT.clean;
  }

  const r = bumpReport(moved, { index, ledger });
  const loud = r.changed.filter((c) => c.severity === 'alarming' || c.severity === 'notable');

  for (const c of r.changed) {
    const tone = c.severity === 'minor' ? C.amber : C.red;
    console.log(`\n  ${tone}${c.severity}${C.off}  ${C.bold}${c.pkg}${C.off} ${c.from} → ${c.to}  ${C.dim}${(c.reasons || []).join('; ')}${C.off}`);
    for (const [channel, g] of Object.entries(c.gained || {})) {
      const where2 = channel.startsWith('install.') ? `at install, ${channel.slice(8)}` : channel;
      for (const item of (g.added || []).slice(0, 8)) console.log(`      ${tone}+ ${where2.padEnd(5)} ${readable(item)}${C.off}`);
      for (const item of (g.removed || []).slice(0, 4)) console.log(`      ${C.dim}- ${where2.padEnd(5)} ${readable(item)}${C.off}`);
    }
    if (c.explained) console.log(`      ${C.dim}${c.explained}${C.off}`);
    console.log(`      ${C.dim}${c.source}${C.off}`);
  }
  if (r.same.length) {
    console.log(`\n  ${C.green}${plural(r.same.length, 'upgrade')} compared, behaving the same as before${C.off}`);
    console.log(`      ${C.dim}${r.same.slice(0, 8).map((x) => `${x.pkg} ${x.to}`).join(', ')}${r.same.length > 8 ? `, and ${r.same.length - 8} more` : ''}${C.off}`);
  }
  if (r.unknown.length) {
    console.log(`\n  ${C.amber}${plural(r.unknown.length, 'upgrade')} nobody has compared${C.off}`);
    console.log(`  ${C.dim}Not a pass and not a failure — an honest "I do not know".${C.off}`);
    for (const u of r.unknown.slice(0, 8)) {
      console.log(`      ${C.dim}${u.pkg} ${u.from} → ${u.to}${u.nearest ? ` — ${u.to} was watched against ${u.nearest.against}: ${u.nearest.severity}` : ''}${C.off}`);
    }
    if (r.unknown.length > 8) console.log(`      ${C.dim}… and ${r.unknown.length - 8} more${C.off}`);
  }

  if (loud.length) {
    console.log(`\n  ${C.red}${plural(loud.length, 'upgrade')} to read before merging.${C.off} ${C.dim}That is what "alarming" means here — never "malicious".${C.off}\n`);
    return EXIT.drift;
  }
  if (r.unknown.length && flags['fail-on-unknown']) { console.log(''); return EXIT.unknown; }
  console.log(`\n  ${C.green}nothing to stop for${C.off}\n`);
  return EXIT.clean;
}

/* ── stakeout explain ───────────────────────────────────────────────────── */

async function cmdExplain({ flags, rest }) {
  const spec = rest[0];
  if (!spec) die('Which package?', 'stakeout explain lodash            — every version the index holds\nstakeout explain lodash@4.17.21   — one version');

  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : null;

  const index = await openIndex(flags);

  const entries = version
    ? [index.lookup(name, version)].filter(Boolean).map((e) => ({ version, ...e }))
    : index.versions(name);

  if (!entries.length) {
    console.log(`\n  ${C.amber}The index has never seen ${spec}.${C.off}`);
    console.log(`  ${C.dim}That is an absence of evidence, not evidence of absence.${C.off}\n`);
    return EXIT.clean;
  }

  console.log(`\n  ${C.bold}${name}${C.off}\n`);
  for (const e of entries) {
    const blind = Object.entries(e.canSee || {}).filter(([, v]) => !v).map(([k]) => k);
    console.log(`  ${C.bold}${e.version}${C.off} ${C.dim}· watched with ${e.strategy}${C.off}`);

    let said = false;
    for (const c of CHANNELS) {
      if (!Array.isArray(e[c]) || !e[c].length) continue;
      said = true;
      for (const item of e[c]) console.log(`      ${c.padEnd(5)} ${renderItem(c, item)}`);
    }
    if (!said) {
      console.log(`      ${C.dim}nothing observed${C.off}`);
    }
    if (blind.length) {
      console.log(`      ${C.amber}cannot see: ${blind.join(', ')}${C.off} ${C.dim}— silence there means nothing${C.off}`);
    }
    console.log('');
  }
  return EXIT.clean;
}

/* ── stakeout index ─────────────────────────────────────────────────────── */

async function cmdIndex({ flags } = {}) {
  const index = await openIndex(flags || {});
  const m = index.manifest();
  if (!m) {
    console.log(`\n  ${C.amber}No index built yet.${C.off}`);
    console.log(`  ${C.dim}\`npm run index:build\` populates it. Without one, nothing else here can answer anything.${C.off}\n`);
    return EXIT.clean;
  }
  console.log(`\n  ${C.bold}the behavioural index${C.off}\n`);
  console.log(`  packages    ${m.packages.toLocaleString()}`);
  console.log(`  versions    ${m.versions.toLocaleString()}`);
  console.log(`  watched by  ${m.strategies.join(', ') || C.dim + 'nothing' + C.off}`);
  console.log(`  revision    ${m.revision}`);
  console.log(`  built       ${C.dim}${m.generatedAt}${C.off}`);
  if (m.note) console.log(`  ${C.dim}${m.note}${C.off}`);
  console.log('');
  return EXIT.clean;
}

/* ── dispatch ───────────────────────────────────────────────────────────── */

const USAGE = `
  ${C.bold}stakeout${C.off} ${C.dim}— your lockfile pins versions. This pins behaviour.${C.off}

    stakeout lock                walk package-lock.json, write ${DEFAULT_FILE}
    stakeout check               diff the tree against the committed lock
    stakeout upgrade             what the versions bumped since a commit now do differently
    stakeout explain <pkg>       what a package does, and who watched it
    stakeout index               what the index holds

  ${C.dim}flags${C.off}
    --lockfile <path>            default package-lock.json
    --lock <path>                default ${DEFAULT_FILE}
    --out <path>                 where \`lock\` writes
    --dry-run                    \`lock\` prints what it would do
    --fail-on-unknown            \`check\` exits 2 when the index has gaps
    --index <url|path>           read a published index instead of a local one
    --against <rev>              \`upgrade\` compares the lockfile with this commit's (default HEAD)
    --watched <url|path>         \`upgrade\` reads watched release pairs from here

  ${C.dim}with no index of your own${C.off}
    stakeout lock --index https://cassandra-nu.vercel.app/index.json
    ${C.dim}1,589 packages somebody already ran. Most of your tree will come back${C.off}
    ${C.dim}unknown, because most of npm has never been watched. That is the answer.${C.off}

  ${C.dim}exit codes: 0 clean · 1 drift · 2 unknown · 3 usage${C.off}
`;

const COMMANDS = { lock: cmdLock, check: cmdCheck, upgrade: cmdUpgrade, explain: cmdExplain, index: cmdIndex };

async function main(argv) {
  const { flags, rest } = parseArgs(argv);
  const command = rest.shift();

  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return command ? EXIT.clean : EXIT.usage;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`\n  ${C.red}No command "${command}".${C.off}`);
    console.log(USAGE);
    return EXIT.usage;
  }
  return fn({ flags, rest });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      // An unexpected failure is an environment error, never a finding. A pipeline that cannot tell
      // the difference learns to ignore both.
      console.error(`\n  ${C.red}${e.message}${C.off}\n`);
      process.exit(EXIT.usage);
    }
  );
}

module.exports = { main, parseArgs, EXIT, renderItem };
