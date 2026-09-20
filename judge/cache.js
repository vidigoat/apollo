/**
 * Cache what the models said about a diff.
 *
 * `cache.js` at the repo root caches BEHAVIOUR — the expensive part of watching a package, which is
 * forking machines and installing things. It does not cache JUDGEMENT, and that turned out to be a
 * hole with a bill attached.
 *
 * Every load of `/api/run` re-judged the same fifteen packages from scratch. On a laptop that is
 * invisible. On the public demo URL the Nebius submission requires, it means a judge who refreshes
 * the page ten times has paid for ninety Nemotron calls to be told the same thing ten times — and
 * this project's entire argument is that you should not pay a model to re-read evidence it has
 * already read. It was making exactly the mistake it exists to complain about.
 *
 * Found by watching the ledger climb to $0.1249 across 145 calls in an afternoon of screenshots.
 *
 * ── What the key has to contain ─────────────────────────────────────────────
 *
 * A verdict is a function of the EVIDENCE, the PROMPT and the MODELS. Change any of the three and
 * the cached answer is about a different question, so all three go into the hash:
 *
 *   evidence   the diff's own content — severity, reasons, and every channel that moved. Not the
 *              package name: two packages producing identical evidence deserve the same answer,
 *              and pretending otherwise would hide a real duplicate.
 *   prompt     PROMPT_VERSION below, bumped by hand when judge/prompt.js changes. The prompt was
 *              hardened once already after a live injection got through, and serving verdicts from
 *              the old one would have quietly undone that.
 *   models     the three ids. Swapping Ultra for something else is a different judgement.
 *
 * Deliberately NOT cached: anything where `simulated` is true. An offline verdict is a stand-in,
 * and freezing one into the cache would make a keyless run permanently poison a keyed one.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * Bump this whenever judge/prompt.js changes in a way that could change an answer.
 *
 * By hand, on purpose. Hashing the prompt file itself would invalidate every entry over a typo in
 * a comment, and a cache that clears itself on every edit is not a cache.
 */
const PROMPT_VERSION = 3;

const SCHEMA = 1;

const DEFAULT_DIR =
  process.env.STAKEOUT_JUDGE_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'stakeout', 'judgements');

/** Every field of the evidence that could move a verdict, in a stable order. */
function evidenceOf(d) {
  const channel = (list = []) => list.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).sort();
  return JSON.stringify({
    severity: d.severity,
    reasons: [...(d.reasons || [])].sort(),
    strategy: d.strategy,
    net: channel(d.net?.added),
    dns: channel(d.dns?.added),
    fs: channel(d.fs?.added),
    env: channel(d.env?.added),
    proc: channel(d.proc?.added),
    exec: channel(d.exec?.added),
  });
}

function keyFor({ diff, models, record }) {
  const material = [
    `v${SCHEMA}`,
    `p${PROMPT_VERSION}`,
    Object.values(models || {}).sort().join(','),
    // The public record is part of the question: "nothing on the web mentions this" and "a
    // changelog explains it" are different prompts and must not share an answer.
    record?.verdict || 'no-record',
    evidenceOf(diff),
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

class JudgementCache {
  constructor({ dir = DEFAULT_DIR, enabled = true } = {}) {
    this.dir = dir;
    this.enabled = enabled;
    this.hits = 0;
    this.misses = 0;
  }

  path(id) {
    return path.join(this.dir, id.slice(0, 2), `${id}.json`);
  }

  /** @returns {object|null} a cached judgement, or null. Never throws: a broken cache costs money, not a run. */
  get(job) {
    if (!this.enabled) return null;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(this.path(keyFor(job)), 'utf8'));
    } catch {
      this.misses++;
      return null;
    }
    if (entry.schema !== SCHEMA || entry.promptVersion !== PROMPT_VERSION) {
      this.misses++;
      return null;
    }
    this.hits++;
    // `cached` rides along so a caller can say so rather than implying the models just ran.
    return { ...entry.judgement, cached: true };
  }

  put(job, judgement) {
    if (!this.enabled) return;
    // A simulated verdict is a stand-in for an answer, not an answer. Freezing one would let a
    // keyless run poison every later keyed one, which is the opposite of useful.
    if ((judgement.spend || []).some((s) => s.simulated)) return;
    if (!judgement.judged) return;

    const file = this.path(keyFor(job));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        schema: SCHEMA,
        promptVersion: PROMPT_VERSION,
        judgedAt: new Date().toISOString(),
        judgement,
      }, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      // Not being able to cache is a cost problem, never a correctness one. Carry on.
    }
  }

  summary() {
    const total = this.hits + this.misses;
    if (!total) return 'no judgements looked up';
    return `${this.hits} of ${total} judgements served from cache`;
  }
}

module.exports = { JudgementCache, keyFor, PROMPT_VERSION, SCHEMA, DEFAULT_DIR };
