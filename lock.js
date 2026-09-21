/**
 * `stakeout.lock` — a behavioural lockfile.
 *
 *   package-lock.json   pins   express@4.18.3                          a VERSION
 *   stakeout.lock       pins   express@4.18.3 reads no environment
 *                              variable, opens no socket, spawns
 *                              nothing, writes only inside node_modules  a BEHAVIOUR
 *
 * You commit it. CI diffs against it. A dependency that changes what it DOES fails the build even
 * when the version did not move — which is precisely the supply-chain shape nothing else catches:
 * a compromised maintainer publishing a patch release that no source diff and no changelog reveals.
 *
 * ── The format is a design decision, not an implementation detail ───────────
 *
 * This file's only real job is to be READ IN A PULL REQUEST. Everything below follows from that:
 *
 *   sorted, always        every key, every array. An unstable order produces diff noise, and diff
 *                         noise is how a reviewer learns to skim a file. Sorting is the difference
 *                         between "three lines changed" and "four hundred lines changed".
 *   one fact per line     the JSON is pretty-printed even though it is bigger, because a
 *                         minified lockfile diffs as one enormous line and reviews as nothing.
 *   absent ≠ empty        a channel the strategy could not watch is OMITTED; a channel it watched
 *                         and found empty is `[]`. Collapsing those would let a blind run read as
 *                         a clean bill of health.
 *   unknowns are listed   a package the index has never seen goes in `unknown`, by name, in the
 *                         file. Leaving it out would make the lock look complete when it is not,
 *                         and "silently incomplete" is the worst state a security artefact can be in.
 *
 * ── What it does not contain ────────────────────────────────────────────────
 *
 * No timings, no pids, no exit codes, no hashes of our own output. Those vary between runs and
 * would make two identical behaviours diff as different — which would train people to ignore the
 * diff, which would make the whole file pointless.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('./index/schema');

const LOCK_VERSION = 1;
const DEFAULT_FILE = 'stakeout.lock';

/** Deep-sorted so two runs over the same facts produce byte-identical files. */
function stable(value) {
  if (Array.isArray(value)) {
    return value
      .map(stable)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

/**
 * Build a lock from a resolved dependency tree.
 *
 * @param {Map<string,string>|object} tree   name → version, from lockfile.js
 * @param {Index} index
 * @returns {{lock: object, known: number, unknown: string[]}}
 */
function buildLock(tree, index) {
  const pairs = tree instanceof Map ? [...tree.entries()] : Object.entries(tree);
  const packages = {};
  const unknown = [];
  const strategies = new Set();

  for (const [name, version] of pairs.sort(([a], [b]) => a.localeCompare(b))) {
    const entry = index.lookup(name, version);
    if (!entry) {
      unknown.push(`${name}@${version}`);
      continue;
    }

    const record = { strategy: entry.strategy };
    strategies.add(entry.strategy);
    for (const c of CHANNELS) {
      // Absent stays absent. See the note at the top: this is the difference between "we watched
      // and saw nothing" and "we could not watch", and the file has to keep them apart.
      if (Array.isArray(entry[c])) record[c] = entry[c];
    }
    packages[`${name}@${version}`] = stable(record);
  }

  const manifest = index.manifest();

  return {
    known: Object.keys(packages).length,
    unknown,
    lock: {
      lockfileVersion: LOCK_VERSION,
      // Which index produced this. Without it, a lock cannot be re-checked against the same facts
      // six months later, and "the answer changed" becomes indistinguishable from "the index did".
      index: {
        revision: manifest?.revision ?? 'unknown',
        packages: manifest?.packages ?? null,
      },
      strategies: [...strategies].sort(),
      generatedAt: new Date().toISOString(),
      packages: stable(packages),
      unknown: unknown.sort(),
    },
  };
}

/**
 * Compare a committed lock against the index as it stands now.
 *
 * Three outcomes, not two, and the third is the one that matters:
 *
 *   drift     a package in the lock now behaves differently. This is the finding.
 *   unknown   a package in the tree the index has never seen. NOT a pass — the honest answer is
 *             "I do not know", and a tool that reports that as clean is worse than no tool.
 *   clean     everything checked, everything matched.
 */
function checkLock(lock, tree, index) {
  const pairs = tree instanceof Map ? [...tree.entries()] : Object.entries(tree);
  const drift = [];
  const unknown = [];
  const added = [];
  let checked = 0;

  for (const [name, version] of pairs.sort(([a], [b]) => a.localeCompare(b))) {
    const key = `${name}@${version}`;
    const was = lock.packages?.[key];
    const now = index.lookup(name, version);

    if (!now) {
      unknown.push(key);
      continue;
    }
    if (!was) {
      // In the tree and in the index, but not in the lock — the dependency is new since the lock
      // was written. Not drift: there is no previous behaviour to have drifted from.
      added.push(key);
      continue;
    }

    checked++;
    const changes = [];
    for (const c of CHANNELS) {
      const before = Array.isArray(was[c]) ? stable(was[c]) : null;
      const after = Array.isArray(now[c]) ? stable(now[c]) : null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ channel: c, before, after });
      }
    }
    if (changes.length) drift.push({ package: key, changes });
  }

  return {
    clean: drift.length === 0,
    checked,
    drift,
    unknown: unknown.sort(),
    added: added.sort(),
  };
}

/** Written with a trailing newline, like every other file a person commits. */
function writeLock(lock, file = DEFAULT_FILE) {
  const abs = path.resolve(file);
  fs.writeFileSync(abs, `${JSON.stringify(lock, null, 2)}\n`);
  return abs;
}

function readLock(file = DEFAULT_FILE) {
  const abs = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // no lock is a state, not an error: it means `stakeout lock` has not been run
  }
  const parsed = JSON.parse(text);
  if (parsed.lockfileVersion !== LOCK_VERSION) {
    throw new Error(
      `${file} was written by lockfile version ${parsed.lockfileVersion}; this is version ` +
        `${LOCK_VERSION}. Re-run \`stakeout lock\` rather than trusting a format this does not know.`
    );
  }
  return parsed;
}

module.exports = { buildLock, checkLock, writeLock, readLock, stable, LOCK_VERSION, DEFAULT_FILE };
