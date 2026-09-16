/**
 * Reading a real dependency tree, and working out what actually moved.
 *
 * This is the difference between a demonstration and a tool. Everything else here has operated on
 * a fixture; this operates on `package-lock.json` — yours, or any repository's, at any two points
 * in its history.
 *
 * The question it answers is the one the whole project exists for, asked about real software:
 * *between these two commits, which of my dependencies changed, and what do those changes do?*
 *
 * npm has shipped three lockfile formats and they are all still in the wild:
 *
 *   v1  (npm 5–6)   "dependencies", nested, versions at each node
 *   v2  (npm 7–8)   "packages" AND "dependencies", the same tree written twice
 *   v3  (npm 9+)    "packages" only, keys are paths like "node_modules/foo/node_modules/bar"
 *
 * Read `packages` when it exists and `dependencies` otherwise, and all three collapse to the same
 * answer. A format we do not recognise is reported as unrecognised, never as an empty tree — an
 * empty tree would read as "nothing to check", which is the most dangerous possible answer here.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const run = promisify(execFile);

/** npm writes the root project into the same map; it is not a dependency of itself. */
const isRoot = (key) => key === '' || key === '.';

/** "node_modules/a/node_modules/b" is package b. The nesting is npm's business, not ours. */
function nameFromPath(key) {
  const parts = key.split('node_modules/');
  return parts[parts.length - 1] || null;
}

/**
 * Every package in a lockfile, as { name: version }.
 *
 * Where the same package appears at several depths with different versions — which happens, and is
 * exactly the situation where you least want a silent answer — the deepest wins and the conflict is
 * reported alongside. Picking one quietly would hide the fact that there were two.
 */
function parseLockfile(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`That is not a lockfile: ${e.message}`);
  }

  const versions = new Map();
  const conflicts = new Map();
  let format;

  const record = (name, version) => {
    if (!name || !version || typeof version !== 'string') return;
    // Only exact releases. A git URL or a file: path has no "version" to compare, and pretending
    // otherwise would produce a diff between two things that are not versions of each other.
    if (!/^\d+\.\d+\.\d+/.test(version)) return;
    const existing = versions.get(name);
    if (existing && existing !== version) {
      const seen = conflicts.get(name) || new Set([existing]);
      seen.add(version);
      conflicts.set(name, seen);
    }
    versions.set(name, version);
  };

  if (json.packages && typeof json.packages === 'object') {
    format = json.lockfileVersion === 2 ? 'v2' : 'v3';
    for (const [key, node] of Object.entries(json.packages)) {
      if (isRoot(key) || !node) continue;
      record(node.name || nameFromPath(key), node.version);
    }
  } else if (json.dependencies && typeof json.dependencies === 'object') {
    format = 'v1';
    const walk = (deps) => {
      for (const [name, node] of Object.entries(deps || {})) {
        if (!node) continue;
        record(name, node.version);
        if (node.dependencies) walk(node.dependencies);
      }
    };
    walk(json.dependencies);
  } else {
    // Not "no packages" — *unreadable*. An empty tree would read as "nothing to check", and there
    // is no answer here more dangerous than that one.
    throw new Error(
      `Unrecognised lockfile: no "packages" or "dependencies" (lockfileVersion ${json.lockfileVersion ?? 'absent'}). ` +
        'Refusing to report an empty tree, which would read as "nothing to check".'
    );
  }

  return {
    format,
    lockfileVersion: json.lockfileVersion ?? null,
    name: json.name ?? null,
    total: versions.size,
    versions,
    conflicts: [...conflicts.entries()].map(([name, set]) => ({ name, versions: [...set] })),
  };
}

/**
 * What moved between two trees.
 *
 * Only packages present in BOTH, because this compares you to your previous version — an addition
 * has no "before" to diff against and a removal has no "after". Both are counted and reported, so
 * the numbers add up and nothing goes missing quietly; they are simply not things this tool can
 * say anything about. See the README's "What this cannot do".
 */
function whatMoved(before, after) {
  const moved = [];
  const added = [];
  const removed = [];

  for (const [name, to] of after.versions) {
    const from = before.versions.get(name);
    if (from === undefined) added.push({ pkg: name, version: to });
    else if (from !== to) moved.push({ pkg: name, from, to });
  }
  for (const [name, from] of before.versions) {
    if (!after.versions.has(name)) removed.push({ pkg: name, version: from });
  }

  moved.sort((a, b) => a.pkg.localeCompare(b.pkg));

  return {
    moved,
    added,
    removed,
    unchanged: after.versions.size - moved.length - added.length,
    total: after.versions.size,
  };
}

/** A lockfile as it was at some commit. Reads from git rather than touching the working tree. */
async function lockfileAtRevision(revision, file = 'package-lock.json', cwd = process.cwd()) {
  try {
    const { stdout } = await run('git', ['show', `${revision}:${file}`], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseLockfile(stdout);
  } catch (e) {
    const why = String(e.stderr || e.message).split('\n')[0];
    if (/does not exist|exists on disk, but not in/.test(why)) {
      throw new Error(`No ${file} at ${revision}. Nothing to compare against.`);
    }
    throw new Error(`Could not read ${file} at ${revision}: ${why}`);
  }
}

/** The lockfile as it is now, on disk. */
function lockfileOnDisk(file = 'package-lock.json', cwd = process.cwd()) {
  const full = path.isAbsolute(file) ? file : path.join(cwd, file);
  if (!fs.existsSync(full)) throw new Error(`No lockfile at ${full}.`);
  return parseLockfile(fs.readFileSync(full, 'utf8'));
}

module.exports = { parseLockfile, whatMoved, lockfileAtRevision, lockfileOnDisk, nameFromPath };
