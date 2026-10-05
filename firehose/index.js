/**
 * Apollo Live — npm, watched as it publishes.
 *
 *   feed ──► select ──► queue ──► runPair in Nebius Sandboxes ──► results.jsonl
 *
 * Two loops share one Queue. `pollOnce` reads a batch of npm's change feed, turns the changes
 * worth a sandbox into jobs, and saves the jobs and the new feed position in one write.
 * `workOnce` takes the most-downloaded job that is due and watches it the way every pair in this
 * project is watched — previous release and new release, two twins from one checkpoint, the
 * differ decides. Nothing here decides how serious anything is.
 *
 * The timestamps are the product. Every result carries when npm says the release was published,
 * when the feed delivered it, and when the verdict existed — so "minutes from publish to verdict"
 * is measured, per release, not claimed.
 */

const { readChanges } = require('./feed');
const { newReleases, publishSignals, lookalike, describeLookalike } = require('./select');
// The same short account of a diff the release watch keeps, so the two records read alike.
const { gained } = require('../scripts/release-watch');

const REGISTRY = (process.env.APOLLO_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');

/**
 * npm's CDN serves a new version a little after the registry records it; an install in that
 * window fails with ETARGET and would be recorded as "not watched" for a reason that is ours, not
 * the package's. So a job is not due until two minutes after its publish, and an install that still
 * cannot find the version is retried — twice, five and fifteen minutes later — before it is
 * recorded as not watched.
 */
const CDN_GRACE_MS = 2 * 60 * 1000;
const NOT_YET_THERE = /ETARGET|E404|No matching version|notarget/i;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000];
// A new package is only a lookalike *candidate* if it is new — an old package with a similar
// name has been in the open for a while, and is somebody else's question.
const NEW_PACKAGE_DAYS = 14;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A full packument (it carries `time`, which the abbreviated form does not). Null when npm has none. */
async function packument(name, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(1500 * 2 ** attempt);
  }
  const e = new Error(`could not read ${name} from the registry (${last})`);
  e.code = 'UNREADABLE';
  throw e;
}

/**
 * The description of the popular package a lookalike imitates, for the "copies its description
 * word for word" signal. Read from `/<name>/latest` (a few kB, where the full packument of a popular
 * package can be megabytes), once per target per process.
 */
const descriptions = new Map();
async function targetDescription(name, { fetchImpl = fetch } = {}) {
  if (descriptions.has(name)) return descriptions.get(name);
  let d = null;
  try {
    const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2f')}/latest`);
    if (res.ok) d = (await res.json()).description || null;
  } catch { /* a missing description only means one signal cannot be checked */ }
  descriptions.set(name, d);
  return d;
}

const latestTime = (pk) => Object.entries(pk?.time || {})
  .filter(([k]) => k !== 'created' && k !== 'modified')
  .reduce((m, [, t]) => Math.max(m, Date.parse(t) || 0), 0);

/**
 * A watched package changed: find what it published since we last looked, and queue each stable
 * release. Returns how many jobs were added.
 */
/*
 * The first 2.7 hours of the live watch owed four releases and queued two: mailauth 6.0.0 and
 * @simple-git/argv-parser 2.0.1 were read when the feed announced them — and the registry answered
 * with the document from BEFORE the publish. No new version in it, so "no release", and nothing
 * looks at a package again unless the feed mentions it again. The feed says which revision it
 * announced; the document says which revision it is. Older than announced is stale, and is asked
 * again later instead of believed.
 */
const revNumber = (rev) => Number(String(rev || '').split('-')[0]) || 0;
const STALE_RETRY_MS = [60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 20 * 60e3];

async function consider(q, name, { population, fetchImpl, sleep, now, rev = null }) {
  const pk = await packument(name, { fetchImpl, sleep });
  if (!pk) { q.count('watched-gone'); return 0; }
  if (rev && revNumber(pk._rev) < revNumber(rev)) {
    const was = q.state.stale[name];
    const attempts = was ? was.attempts + 1 : 0;
    if (attempts >= STALE_RETRY_MS.length) {
      delete q.state.stale[name];
      q.count('stale-gave-up');
      // Not silent: a line in the evidence says this package's release could not be read.
      q.finish(`${name}@stale:${rev}`, { key: `${name}@stale:${rev}`, pkg: name, outcome: 'unobserved', error: `the registry kept serving revision ${pk._rev} after the feed announced ${rev}`, doneAt: new Date(now).toISOString() });
      return 0;
    }
    q.state.stale[name] = { rev, attempts, retryAt: new Date(now + STALE_RETRY_MS[attempts]).toISOString() };
    q.count('stale-packument');
    return 0;
  }
  if (q.state.stale[name]) delete q.state.stale[name];
  const after = q.state.watermarks[name] || q.state.startedAt;
  const found = newReleases(pk, { after });
  q.count('prerelease-skipped', found.prerelease);
  q.count('unpublished-skipped', found.unpublished);
  q.count('first-release-skipped', found.noPrior);
  if (!found.releases.length && !found.prerelease && !found.unpublished && !found.noPrior) q.count('changed-no-release');
  let added = 0;
  for (const r of found.releases) {
    const job = {
      key: `${name}@${r.prior}→${r.version}`,
      pkg: name,
      from: r.prior,
      to: r.version,
      weeklyDownloads: population.get(name) ?? null,
      publishedAt: r.publishedAt,
      seenAt: new Date(now).toISOString(),
      notBefore: new Date(Math.max(now, Date.parse(r.publishedAt) + CDN_GRACE_MS)).toISOString(),
      signals: publishSignals(pk, r.version, r.prior),
    };
    if (q.enqueue(job)) added++;
  }
  const t = latestTime(pk);
  if (t) q.state.watermarks[name] = new Date(Math.max(t, Date.parse(after) || 0)).toISOString();
  q.count('releases-found', added);
  return added;
}

/**
 * One batch of the feed. Everything it found is saved together with the position after it.
 *
 * A packument that cannot be read is not allowed to block the feed or to vanish: it goes on an
 * `unread` list that every later poll tries first, and the status line shows how long that list is.
 */
async function pollOnce(q, { population, lookIdx, fetchImpl = fetch, sleep = defaultSleep, now = Date.now(), limit = 1000 } = {}) {
  if (!Number.isFinite(q.state.seq)) throw new Error('the queue has no feed position; start it with a seq');
  const stats = { changes: 0, watched: 0, jobs: 0, lookalikes: 0 };

  // Packages named for a re-check from outside (scripts/firehose-audit.js --repair writes them):
  // read here, by the process that owns the state, rather than written into it by a second one.
  const recheck = require('node:path').join(q.dir, 'recheck.json');
  if (require('node:fs').existsSync(recheck)) {
    try {
      for (const name of JSON.parse(require('node:fs').readFileSync(recheck, 'utf8'))) {
        if (!q.state.unread[name]) q.state.unread[name] = { since: new Date(now).toISOString(), attempts: 0, recheck: true };
      }
    } catch { /* an unreadable request is dropped, and says so below */ q.count('recheck-unreadable'); }
    require('node:fs').rmSync(recheck, { force: true });
  }
  // Stale documents whose retry is due, before the new batch.
  for (const [name, st] of Object.entries(q.state.stale)) {
    if (Date.parse(st.retryAt) > now) continue;
    try {
      stats.jobs += await consider(q, name, { population, fetchImpl, sleep, now, rev: st.rev });
    } catch (e) {
      if (e.code !== 'UNREADABLE') throw e;
    }
  }

  for (const name of Object.keys(q.state.unread)) {
    try {
      stats.jobs += await consider(q, name, { population, fetchImpl, sleep, now });
      delete q.state.unread[name];
    } catch (e) {
      if (e.code !== 'UNREADABLE') throw e;
      q.state.unread[name].attempts++;
    }
  }

  const { results, lastSeq } = await readChanges({ since: q.state.seq, limit, fetchImpl, sleep });
  for (const change of results) {
    stats.changes++;
    q.count('changes');
    if (change.deleted) { q.count('deleted'); continue; }
    const name = change.id;
    if (population.has(name)) {
      stats.watched++;
      q.count('watched-changed');
      try {
        stats.jobs += await consider(q, name, { population, fetchImpl, sleep, now, rev: change.changes?.[0]?.rev || null });
      } catch (e) {
        if (e.code !== 'UNREADABLE') throw e;
        q.state.unread[name] = { since: new Date(now).toISOString(), attempts: 1, seq: change.seq };
        q.count('unreadable');
      }
      continue;
    }
    const match = lookIdx ? lookalike(name, lookIdx) : null;
    if (!match || q.state.lookalikes[name]) continue;
    let pk = null;
    try { pk = await packument(name, { fetchImpl, sleep }); } catch { q.count('lookalike-unreadable'); continue; }
    if (!pk) continue;
    const created = Date.parse(pk.time?.created);
    if (!Number.isFinite(created) || now - created > NEW_PACKAGE_DAYS * 86400000) continue;
    const described = describeLookalike(pk, match, await targetDescription(match.target, { fetchImpl }));
    // A popular name under somebody's scope is usually an adapter — `@traceora/express` is an
    // Express integration, and the first four minutes against the live feed found two of those and
    // nothing else. So a scope match is a candidate only when the metadata gives a reason on top;
    // the plain ones are counted, so the filter is visible, and not listed.
    // "Names no source repository" alone is not a reason: the first three hours of backfill listed
    // eleven scoped UI-kit packages on it (`@streetui/router`) and nothing else. It still appears
    // on a listed candidate; it just cannot list one.
    const strong = described.signals.filter((x) => x !== 'names no source repository');
    if (match.kind === 'scope' && !strong.length) {
      q.state.lookalikes[name] = 'plain';
      q.count('lookalike-scope-plain');
      continue;
    }
    q.lookalike({ ...described, seenAt: new Date(now).toISOString(), seq: change.seq });
    q.count('lookalikes');
    stats.lookalikes++;
  }
  q.state.seq = lastSeq;
  q.state.lastPollAt = new Date(now).toISOString();
  q.save();
  return { ...stats, full: results.length >= limit };
}

/**
 * Watch one due job. Returns the record written, or null when nothing was due.
 *
 * `runPairImpl` is runPair — the one place in this repository allowed to fork a pair and required
 * to give it back (architecture.test.js). It is a parameter only so the tests can hand in a fake.
 */
async function workOnce(q, { adapter, checkpoint, strategy, runPairImpl, summarise, now = () => Date.now() }) {
  const job = q.take(now());
  if (!job) return null;
  const started = now();
  try {
    const { diff: d } = await runPairImpl({ adapter, checkpoint, pkg: job.pkg, from: job.from, to: job.to, strategy });
    const doneAt = now();
    const record = {
      ...job,
      outcome: 'watched',
      severity: d.severity,
      reasons: d.reasons || [],
      gained: gained(d),
      summary: summarise ? summarise(d) : null,
      seconds: Math.round((doneAt - started) / 1000),
      doneAt: new Date(doneAt).toISOString(),
      minutesPublishToVerdict: Math.round((doneAt - Date.parse(job.publishedAt)) / 6000) / 10,
      strategy,
    };
    q.finish(job.key, record);
    return record;
  } catch (e) {
    const message = String(e.message || e).split('\n')[0].slice(0, 240);
    const attempts = job.attempts || 0;
    const transient = NOT_YET_THERE.test(message) || e.code === 'ETIMEDOUT' || /timed out|ECONNRESET|socket hang up|HTTP 5\d\d|HTTP 429/i.test(message);
    if (transient && attempts < RETRY_DELAYS_MS.length) {
      q.retry(job.key, now() + RETRY_DELAYS_MS[attempts], message);
      return { key: job.key, outcome: 'retrying', error: message };
    }
    // Not watched is its own outcome, recorded with its reason — never folded into "no change".
    const record = { ...job, outcome: e.code === 'UNOBSERVED' ? 'unobserved' : 'failed', error: message, doneAt: new Date(now()).toISOString(), strategy };
    q.finish(job.key, record);
    return record;
  }
}

module.exports = { packument, consider, pollOnce, workOnce, CDN_GRACE_MS, RETRY_DELAYS_MS, NEW_PACKAGE_DAYS };
