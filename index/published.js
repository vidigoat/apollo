/**
 * A published index, read from a URL or a file, with the same shape as a local one.
 *
 *   const index = await open('https://cassandra-nu.vercel.app/index.json');
 *   index.lookup('left-pad', '1.3.0');
 *
 * ── Why this is separate from index/schema.js ───────────────────────────────
 *
 * A local index is a directory of sharded files, opened lazily, written to as observations arrive.
 * A published one is a single immutable document somebody fetched. They answer the same questions
 * and they are not the same object, and making one class do both would mean a `put()` that
 * sometimes silently does nothing — which is exactly the kind of interface that ends with somebody
 * believing they recorded a run.
 *
 * So: a read-only index with `lookup`, `versions`, `manifest` and `summary`, and no `put` at all.
 * Anything that takes an index takes this one.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const { CAN_SEE } = require('../transcript/schema');
const { SCHEMA } = require('./schema');

class PublishedIndex {
  constructor(doc, { from = 'a published index' } = {}) {
    if (!doc || typeof doc !== 'object') throw new Error(`${from} is not an index`);
    if (doc.schema !== SCHEMA) {
      throw new Error(
        `${from} is schema ${doc.schema ?? 'unstated'} and this build reads schema ${SCHEMA}. ` +
          'Refusing to read it rather than guessing at the difference.'
      );
    }
    if (!doc.packages || typeof doc.packages !== 'object') throw new Error(`${from} holds no packages`);

    this.doc = doc;
    this.from = from;
    this.hits = 0;
    this.misses = 0;
  }

  package(name) {
    const versions = this.doc.packages[name];
    return versions ? { schema: SCHEMA, name, versions } : null;
  }

  /**
   * What did `name@version` do?
   *
   * Null means never observed. It does not mean "observed and quiet", and `checkLock` reports the
   * two as different outcomes — which is the only reason a published index is safe to hand to
   * somebody else's repository, where most of the tree will be unknown.
   */
  lookup(name, version) {
    const entry = this.doc.packages[name]?.[version] ?? null;
    if (entry) this.hits++;
    else this.misses++;
    /*
     * Restated from THIS BUILD's table, not from the file.
     *
     * The published document carries the visibility table it was written with, and a reader whose
     * copy of the code disagrees has to resolve that somehow. It resolves toward the local table,
     * because `quietness()` here is what will interpret the entry — reading a remote claim about
     * what was watched with local code that means something else by it is how an overclaim travels.
     * `mismatch()` reports the disagreement rather than hiding it.
     */
    if (entry && CAN_SEE[entry.strategy]) return { ...entry, canSee: { ...CAN_SEE[entry.strategy] } };
    return entry;
  }

  versions(name) {
    const all = this.doc.packages[name] || {};
    return Object.entries(all)
      .map(([version, e]) => ({ version, ...this.lookup(name, version), version }))
      .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  }

  manifest() {
    return {
      schema: this.doc.schema,
      revision: this.doc.revision,
      packages: this.doc.counts?.packages ?? Object.keys(this.doc.packages).length,
      versions: this.doc.counts?.versions ?? 0,
      strategies: this.doc.strategies || [],
      generatedAt: this.doc.generatedAt,
      published: this.from,
    };
  }

  summary() {
    const m = this.manifest();
    return `${m.versions.toLocaleString()} observations of ${m.packages.toLocaleString()} packages (${m.revision})`;
  }

  /**
   * Where the published table and this build's table disagree about what a strategy can see.
   *
   * Empty is the normal answer. When it is not, the index was published by a build with a different
   * idea of what was being watched, and a reader should be told rather than quietly given the local
   * interpretation of somebody else's recording.
   */
  mismatch() {
    const out = [];
    for (const [strategy, theirs] of Object.entries(this.doc.canSee || {})) {
      const ours = CAN_SEE[strategy];
      if (!ours) { out.push(`${strategy}: this build does not define it`); continue; }
      for (const channel of Object.keys(ours)) {
        if (String(ours[channel]) !== String(theirs[channel])) {
          out.push(`${strategy}.${channel}: published as ${JSON.stringify(theirs[channel])}, here it is ${JSON.stringify(ours[channel])}`);
        }
      }
    }
    return out;
  }
}

/**
 * Open a published index from a URL or a path.
 *
 * `gzip` is decoded here rather than relied on from the transport, because a file saved from a
 * browser and a file fetched by `fetch` do not arrive the same way and a reader should not have to
 * know which one they have.
 */
async function open(where, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (/^https?:\/\//.test(where)) {
    const stop = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetchImpl(where, { signal: stop, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${where} answered ${res.status}`);
    const text = await res.text();
    return new PublishedIndex(parse(text, where), { from: where });
  }

  const raw = fs.readFileSync(where);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return new PublishedIndex(parse(text, where), { from: where });
}

function parse(text, where) {
  try {
    return JSON.parse(text);
  } catch {
    /*
     * The single most likely failure: a URL that serves an HTML error page with a 200. Saying "not
     * valid JSON" would send somebody to look at the index; saying what actually arrived sends them
     * to look at the URL.
     */
    const head = text.slice(0, 60).replace(/\s+/g, ' ');
    throw new Error(`${where} did not return an index — it returned: ${head}…`);
  }
}

module.exports = { PublishedIndex, open };
