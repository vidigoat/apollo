/**
 * npm's change feed: every document the public registry writes, in the order it wrote them.
 *
 *   https://replicate.npmjs.com/registry/_changes?since=<seq>&limit=<n>
 *
 * Each result is `{ seq, id, changes: [{ rev }], deleted? }` — a package document changed, and
 * nothing more: which version, and when it was published, has to be asked of the registry
 * separately (select.js). The feed keeps only the latest change per document, so a burst of
 * publishes to one package arrives as one result; that is fine here, because the packument is
 * read whole and every version published since the last read is found in it.
 *
 * The one property everything else leans on: a sequence number is a position that can be resumed
 * from. The watcher saves its position only after the jobs a batch produced are saved (queue.js),
 * so a crash, a restart or a laptop lid closing overnight means catching up — never a gap. That is
 * the difference between "we watched npm for a day" and "we watched most of a day".
 */

const FEED = (process.env.STAKEOUT_NPM_FEED || 'https://replicate.npmjs.com/registry').replace(/\/+$/, '');

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the feed is now — the position a fresh watcher starts from, so it watches what is published
 * from here on rather than replaying months of history.
 */
async function currentSeq({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${FEED}/`);
  if (!res.ok) throw new Error(`npm's replication endpoint answered ${res.status}`);
  const j = await res.json();
  if (!Number.isFinite(j.update_seq)) throw new Error('npm\'s replication endpoint gave no update_seq');
  return j.update_seq;
}

/**
 * One batch after `since`. Retries what is worth retrying — a 429 or a 5xx is npm being busy, not
 * npm saying no — and gives up loudly after that, because a watcher that quietly stops reading
 * looks exactly like a quiet day on npm.
 */
async function readChanges({ since, limit = 1000, fetchImpl = fetch, sleep = defaultSleep, attempts = 6 } = {}) {
  if (!Number.isFinite(since)) throw new Error('readChanges needs a numeric since');
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${FEED}/_changes?since=${since}&limit=${limit}`);
    } catch (e) {
      lastError = e.message;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`npm's change feed answered ${res.status} for since=${since}`);
    const j = await res.json();
    if (!Array.isArray(j.results) || !Number.isFinite(j.last_seq)) throw new Error('npm\'s change feed returned something that is not a change list');
    // An empty batch answers with last_seq at or before `since`; never move the position backwards.
    return { results: j.results, lastSeq: Math.max(since, j.last_seq) };
  }
  throw new Error(`npm's change feed would not answer after ${attempts} tries (last: ${lastError})`);
}

module.exports = { FEED, currentSeq, readChanges };
