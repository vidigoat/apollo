/**
 * What we already know about a version bump.
 *
 * A behavioural diff is expensive to produce and permanent once produced. `lodash 4.17.20 → 4.17.21`
 * did what it did; it will not do something else next Tuesday. So the second time anyone asks —
 * next week, on another branch, in another repository — the answer should be free.
 *
 * This is what makes the idea scale past one run. A per-repository tool pays the full cost every
 * time. A tool with a cache pays it once per *version pair in the world*, and most teams upgrade
 * the same popular packages as everyone else.
 *
 * ── The key is the whole point ──────────────────────────────────────────────
 *
 * `pkg@from→to` is NOT enough. A run watched with `fsdiff` and a run watched with `nodert` are
 * different questions with different answers, and serving one for the other would resurrect exactly
 * the bug this project keeps finding: reporting something we could not see as something that did
 * not happen. The strategy is part of the key, and so is the schema version — a transcript shape
 * that has changed is a transcript that cannot be compared with an old one.
 *
 * ── What is deliberately not cached ─────────────────────────────────────────
 *
 * Only the behavioural diff, which is arithmetic over two recordings and therefore stable. Not the
 * model's judgement, which depends on a prompt that changes, and not the public record, which is
 * the one input that legitimately changes over time — a package with no advisory today may have one
 * next month, and a cached "nothing found" would quietly become a lie.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Bump when the transcript or diff shape changes. Old entries then simply stop matching. */
const SCHEMA = 2;

const DEFAULT_DIR =
  process.env.STAKEOUT_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'stakeout');

/** Content-addressed, so the filename carries everything that makes the answer what it is. */
function keyFor({ pkg, from, to, strategy }) {
  const material = `v${SCHEMA}|${strategy}|${pkg}@${from}->${to}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

class BehaviourCache {
  constructor({ dir = DEFAULT_DIR, enabled = true } = {}) {
    this.dir = dir;
    this.enabled = enabled;
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
  }

  path(id) {
    // One level of fan-out: a popular cache holds tens of thousands of files and a flat directory
    // of that size is slow to list on every filesystem that matters.
    return path.join(this.dir, id.slice(0, 2), `${id}.json`);
  }

  /**
   * @returns {object|null} the cached diff, or null. Never throws: a broken cache must degrade to
   *   a slow run, never to a failed one.
   */
  get(job) {
    if (!this.enabled) return null;
    const file = this.path(keyFor(job));
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      this.misses++;
      return null;
    }

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Half-written, or written by something else. Drop it and run.
      fs.rmSync(file, { force: true });
      this.misses++;
      return null;
    }

    // Belt and braces: the key already encodes these, but a hash collision or a hand-edited cache
    // would otherwise serve one package's behaviour as another's, which is unforgivable here.
    if (
      entry.schema !== SCHEMA ||
      entry.pkg !== job.pkg ||
      entry.from !== job.from ||
      entry.to !== job.to ||
      entry.strategy !== job.strategy
    ) {
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.diff;
  }

  /** Write atomically: a reader must never see half an entry. */
  put(job, diff) {
    if (!this.enabled) return;
    const id = keyFor(job);
    const file = this.path(id);
    const entry = {
      schema: SCHEMA,
      pkg: job.pkg,
      from: job.from,
      to: job.to,
      strategy: job.strategy,
      // When, so a human reading the cache can tell how old an answer is. Never used to expire one:
      // a behavioural diff does not go stale, which is the whole premise.
      observedAt: new Date().toISOString(),
      diff,
    };

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
      this.writes++;
    } catch {
      // A cache that cannot be written is a slower tool, not a broken one.
    }
  }

  stats() {
    return { hits: this.hits, misses: this.misses, writes: this.writes, dir: this.dir };
  }

  /** Everything we have ever learned, for `--cache-list`. */
  entries() {
    const out = [];
    let shards;
    try {
      shards = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const shard of shards) {
      let files;
      try {
        files = fs.readdirSync(path.join(this.dir, shard));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const e = JSON.parse(fs.readFileSync(path.join(this.dir, shard, f), 'utf8'));
          out.push({ pkg: e.pkg, from: e.from, to: e.to, strategy: e.strategy, severity: e.diff?.severity, observedAt: e.observedAt });
        } catch { /* skip an unreadable entry rather than failing a listing */ }
      }
    }
    return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

module.exports = { BehaviourCache, keyFor, SCHEMA, DEFAULT_DIR };
