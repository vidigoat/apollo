/**
 * The watcher's memory: where it is in npm's feed, what it has found, what it has watched.
 *
 * One state file, written whole and renamed into place, so it is never half-written. The feed
 * position and the queue live in the SAME file on purpose: the jobs a batch produced and the
 * position after that batch are saved in one write, so there is no moment at which the position
 * has moved past work that was not saved. A crash re-reads the last batch, and dedupe (a job's key
 * is `pkg@from→to`) makes that harmless.
 *
 * What is appended, never rewritten: `results.jsonl` (every pair watched, one line each, with its
 * timestamps) and `lookalikes.jsonl` (every imitation found). Those are the evidence; the state
 * file is only bookkeeping.
 *
 * Nothing is dropped without a record. A job either ends in results.jsonl — watched, or "not
 * watched" with the reason — or is still in the queue. Anything else would make "caught X of N"
 * a number about a population nobody can see.
 */

const fs = require('node:fs');
const path = require('node:path');

const EMPTY = () => ({
  version: 1,
  seq: null,
  startedAt: null,
  watermarks: {},
  pending: [],
  running: {},
  done: {},
  unread: {},
  stale: {},
  lookalikes: {},
  counts: {},
});

class Queue {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.state = fs.existsSync(this.file) ? { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } : EMPTY();
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  count(name, n = 1) {
    this.state.counts[name] = (this.state.counts[name] || 0) + n;
  }

  /**
   * A job the last process was running when it stopped goes back in the queue. It may have been
   * half-watched; watching it again costs one pair, and recording it as done would be a lie.
   */
  recover() {
    const back = Object.values(this.state.running);
    for (const job of back) this.state.pending.push({ ...job, recovered: (job.recovered || 0) + 1 });
    this.state.running = {};
    if (back.length) this.save();
    return back.length;
  }

  has(key) {
    return Boolean(this.state.done[key] || this.state.running[key] || this.state.pending.some((j) => j.key === key));
  }

  /** Add a job unless it is already known. Returns whether it was added. The caller saves. */
  enqueue(job) {
    if (this.has(job.key)) return false;
    this.state.pending.push({ attempts: 0, ...job });
    return true;
  }

  /**
   * The next job that may start now: most-downloaded first — a release everyone installs is the
   * one worth seeing soonest — then oldest first. A job that is not yet due (npm's CDN has not
   * caught up with a publish; a retry is waiting) is left where it is.
   */
  take(now = Date.now()) {
    let best = -1;
    for (let i = 0; i < this.state.pending.length; i++) {
      const j = this.state.pending[i];
      if (j.notBefore && Date.parse(j.notBefore) > now) continue;
      if (best < 0) { best = i; continue; }
      const b = this.state.pending[best];
      const dj = j.weeklyDownloads ?? -1;
      const db = b.weeklyDownloads ?? -1;
      if (dj > db || (dj === db && Date.parse(j.seenAt) < Date.parse(b.seenAt))) best = i;
    }
    if (best < 0) return null;
    const [job] = this.state.pending.splice(best, 1);
    job.startedAt = new Date(now).toISOString();
    this.state.running[job.key] = job;
    this.save();
    return job;
  }

  /** The job is over — watched, or not watched and why. Appended to the evidence, then forgotten. */
  finish(key, record) {
    delete this.state.running[key];
    this.state.done[key] = record.outcome;
    this.count(`outcome:${record.outcome}`);
    fs.appendFileSync(path.join(this.dir, 'results.jsonl'), `${JSON.stringify(record)}\n`);
    this.save();
  }

  /** Back in the queue, not before `at`. */
  retry(key, at, reason) {
    const job = this.state.running[key];
    delete this.state.running[key];
    if (job) this.state.pending.push({ ...job, attempts: (job.attempts || 0) + 1, notBefore: new Date(at).toISOString(), lastError: reason });
    this.count('retried');
    this.save();
  }

  lookalike(record) {
    this.state.lookalikes[record.name] = record.createdAt || true;
    fs.appendFileSync(path.join(this.dir, 'lookalikes.jsonl'), `${JSON.stringify(record)}\n`);
  }

  /** What is true right now, for a status line or the report. */
  status(now = Date.now()) {
    const pending = this.state.pending;
    const oldest = pending.reduce((m, j) => Math.min(m, Date.parse(j.seenAt) || now), now);
    return {
      seq: this.state.seq,
      pending: pending.length,
      due: pending.filter((j) => !j.notBefore || Date.parse(j.notBefore) <= now).length,
      running: Object.keys(this.state.running).length,
      done: Object.keys(this.state.done).length,
      unread: Object.keys(this.state.unread).length,
      stale: Object.keys(this.state.stale || {}).length,
      oldestPendingMinutes: pending.length ? Math.round((now - oldest) / 60000) : 0,
      counts: this.state.counts,
    };
  }
}

module.exports = { Queue };
