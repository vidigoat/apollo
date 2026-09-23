/**
 * The behavioural index.
 *
 * Every other surface in this project is a thin client over this file. The index answers one
 * question — *what does `package@version` actually do?* — and answers it from a run that already
 * happened, somewhere else, once.
 *
 * ── Why an index at all ─────────────────────────────────────────────────────
 *
 * Running a package is the expensive part. Do it once, centrally, publish the result, and checking
 * your hundredth repository becomes a LOOKUP rather than a hundred sandbox runs. That is the
 * difference between a demonstration that watches fifteen fixed packages and a tool somebody can
 * point at their own lockfile — and it is the only way "scale" here means anything.
 *
 * ── What an entry is, and is not ────────────────────────────────────────────
 *
 * An entry records the six channels a package touched, and the STRATEGY that watched it. The
 * strategy is not metadata; it is half the claim. `nodert` watching nothing means "nothing crossed
 * Node's API surface", which is a weaker statement than `ebpf` watching nothing, and an index that
 * flattened them into a single "quiet" would be telling its users something it does not know.
 *
 * `transcript/schema.js` already deletes any channel a strategy cannot see, so a blind channel
 * arrives here as absent rather than empty — and `quietness()` is the only thing allowed to turn
 * that into a claim.
 *
 * ── Format ──────────────────────────────────────────────────────────────────
 *
 *   index/
 *     manifest.json            revision, strategy, counts, when
 *     entries/<aa>/<name>.json one file per package, all versions inside it
 *
 * One file per PACKAGE rather than per version, because the question a lockfile asks is "what do
 * these two versions of this one package do differently", and answering it from one file rather
 * than two halves the reads. Sharded by a hash prefix because a flat directory of twenty thousand
 * files is slow to list on every filesystem that matters.
 *
 * Static JSON on purpose: it can be served from anywhere, cached by anything, and committed. There
 * is no database to run and nothing to keep alive.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CAN_SEE, unobserved } = require('../transcript/schema');

/**
 * Bump when the shape of an entry changes in a way that would make an old one misread.
 * Not when the CONTENT changes — a new package is not a new schema.
 */
const SCHEMA = 1;

const CHANNELS = ['net', 'dns', 'fs', 'env', 'proc', 'exec'];

const DEFAULT_DIR = process.env.STAKEOUT_INDEX || path.join(__dirname, 'data');

/** Scoped names (`@scope/name`) are legal filenames nowhere, so everything goes through a hash. */
function shardFor(name) {
  return crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 2);
}

function fileFor(dir, name) {
  return path.join(dir, 'entries', shardFor(name), `${encodeURIComponent(name)}.json`);
}

/**
 * One package's behaviour at one version, in the shape the index stores.
 *
 * Deliberately NOT the whole transcript. Timing, pids and exit codes vary between runs and would
 * make two identical behaviours look different; the index keeps only what is stable and what a
 * reader would check.
 */
function entryFor(transcript) {
  const out = {
    version: transcript.version,
    strategy: transcript.strategy,
    canSee: transcript.canSee,
    observedAt: new Date().toISOString(),
  };
  /*
   * A simulated entry says so, permanently, in the file.
   *
   * This was a real accident, not a hypothetical. A build invoked with `--simulated` and no limit
   * wrote 8,623 fabricated entries straight over an index that held 705 genuine observations, and
   * nothing about a single entry afterwards said which was which — the only marker was a `note` on
   * the manifest, which is the wrong grain entirely. Every number the fleet page prints is built on
   * these entries. Fabricated data that cannot be told apart from observed data is the one failure
   * that would make this whole project worthless, so it is recorded per entry, at the point of
   * writing, and `put` refuses to mix the two.
   */
  if (transcript.simulated) out.simulated = true;
  // Where it was watched, when that is known. Absent means not recorded — entries built before this
  // field existed — never "nowhere".
  if (transcript.observedOn) out.observedOn = String(transcript.observedOn).slice(0, 60);
  for (const c of CHANNELS) {
    // Absent means the strategy could not see it. Empty means it saw nothing. Those are different
    // facts and the index has to be able to express both.
    if (Array.isArray(transcript[c])) out[c] = transcript[c];
  }
  // What its install scripts did, when that phase was watched. Absent: not watched (every entry
  // before 23 Sep), never "ran nothing".
  if (transcript.install && typeof transcript.install === 'object') {
    out.install = Object.fromEntries(CHANNELS.filter((c) => Array.isArray(transcript.install[c])).map((c) => [c, transcript.install[c]]));
  }
  return out;
}

/**
 * What a strategy can see is a property of the STRATEGY, not of any one observation.
 *
 * ── Why this function exists ────────────────────────────────────────────────
 *
 * Every entry stores a copy of the CAN_SEE row it was observed under, which is convenient and makes
 * the entry self-describing. It also means the copy is a snapshot of what we BELIEVED at the moment
 * of observation — and when that belief turns out to be wrong, every entry written before the
 * correction keeps asserting the old thing forever.
 *
 * That is not hypothetical. `nodert` was recorded as `fs: true` for months. It is not: the probe
 * hooks writes, and a package that only READS a file is invisible to it. The table was corrected;
 * the 2,129 entries already on disk were not, and every one of them still claimed the filesystem
 * had been watched in full. `quietness()` reads `canSee` to decide what a silence is worth, so
 * every claim derived from the index was quietly overstating what anybody had actually looked at —
 * which is the one thing this project exists not to do.
 *
 * Re-observing 2,129 packages to correct a field that was never an observation would be absurd. So
 * the stored copy is treated as what it is: a cache of a table, restated from the table on read.
 * An entry whose strategy the table does not know is left exactly as written, because inventing a
 * visibility for a strategy nobody here defines would be the same mistake wearing a fix's clothes.
 */
function restate(entry) {
  const table = CAN_SEE[entry?.strategy];
  if (table) entry.canSee = { ...table };
  return entry;
}

class Index {
  constructor({ dir = DEFAULT_DIR } = {}) {
    this.dir = dir;
    this.hits = 0;
    this.misses = 0;
    this._cache = new Map(); // one package's file, parsed, per process
  }

  /** @returns {object|null} the whole package record, or null. Never throws. */
  package(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(fileFor(this.dir, name), 'utf8'));
      if (record.schema !== SCHEMA) record = null;
      if (record) for (const entry of Object.values(record.versions || {})) restate(entry);
    } catch {
      record = null;
    }
    this._cache.set(name, record);
    return record;
  }

  /**
   * What did `name@version` do?
   *
   * @returns {object|null} an entry, or null when the index has never seen this version. Null is a
   *   real answer and callers must not treat it as "nothing happened" — see `stakeout check`,
   *   which reports `unknown` as its own outcome rather than passing.
   */
  lookup(name, version) {
    const record = this.package(name);
    const entry = record?.versions?.[version] ?? null;
    if (entry) this.hits++;
    else this.misses++;
    return entry;
  }

  /** Every version of a package the index holds, newest-observed first. */
  versions(name) {
    const record = this.package(name);
    if (!record) return [];
    return Object.entries(record.versions || {})
      .map(([version, e]) => ({ version, ...e }))
      .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  }

  /** Write or replace one version's entry. Atomic, so a reader never sees half a file. */
  put(name, transcript) {
    // A version that never installed, or whose probe never reported, is not written at all: absent
    // is "unknown", and `stakeout check` says so. Written with empty channels it would read as clean.
    const why = unobserved(transcript);
    if (why) throw new Error(`Refusing to index ${why}.`);
    const file = fileFor(this.dir, name);
    const existing = this.package(name) || { schema: SCHEMA, name, versions: {} };
    const entry = entryFor(transcript);

    /*
     * An index is either observed or it is a rehearsal. Never half of each.
     *
     * Refusing here rather than warning is deliberate: the damage from a mixed index is silent and
     * total, because every downstream number reads it as fact. Point a simulated build at its own
     * directory (`--out`), or delete the real one on purpose.
     */
    const priorSimulated = Object.values(existing.versions).some((v) => v.simulated);
    const priorReal = Object.values(existing.versions).some((v) => !v.simulated);
    if (entry.simulated && priorReal) {
      throw new Error(
        `Refusing to write a simulated entry for ${name} into an index holding real observations. ` +
        'Build simulated runs into their own directory with --out.'
      );
    }
    if (!entry.simulated && priorSimulated) {
      throw new Error(
        `Refusing to write a real observation for ${name} into an index holding simulated entries. ` +
        'Delete the simulated index first.'
      );
    }

    existing.versions[transcript.version] = entry;
    existing.updatedAt = new Date().toISOString();

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    fs.renameSync(tmp, file);
    this._cache.set(name, existing);
    return existing;
  }

  has(name, version) {
    return this.lookup(name, version) !== null;
  }

  /** @returns {{revision, strategy, packages, versions, generatedAt}|null} */
  manifest() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Recount from the files themselves and rewrite the manifest.
   *
   * Counted rather than tracked, because a counter that drifts from the files is worse than no
   * counter: it is the number a README would quote.
   */
  writeManifest({ revision = new Date().toISOString().slice(0, 10), note = '' } = {}) {
    let packages = 0;
    let versions = 0;
    const strategies = new Set();

    const entries = path.join(this.dir, 'entries');
    for (const shard of safeReaddir(entries)) {
      for (const f of safeReaddir(path.join(entries, shard))) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(entries, shard, f), 'utf8'));
          packages++;
          for (const v of Object.values(r.versions || {})) {
            versions++;
            if (v.strategy) strategies.add(v.strategy);
          }
        } catch {
          /* a half-written file is not a package; the next build will replace it */
        }
      }
    }

    const manifest = {
      schema: SCHEMA,
      revision,
      packages,
      versions,
      strategies: [...strategies].sort(),
      generatedAt: new Date().toISOString(),
      note,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  summary() {
    const m = this.manifest();
    if (!m) return 'no index built yet';
    return `${m.packages.toLocaleString()} packages · ${m.versions.toLocaleString()} versions · ` +
      `watched with ${m.strategies.join(', ') || 'nothing'} · rev ${m.revision}`;
  }
}

const safeReaddir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

module.exports = { Index, entryFor, fileFor, shardFor, SCHEMA, CHANNELS, DEFAULT_DIR };
