/**
 * The live watch's record, as fresh as it can be had without a deploy.
 *
 * `public/watched-releases.json` is bundled when the site is deployed, so by itself it is as old as
 * the last deploy. The watcher's machine also publishes the same file somewhere it can update on
 * its own (public/live-source.json says where). This reads the bundled copy at once and, at most
 * every ten minutes, asks for the published one — keeping whichever was written later.
 *
 * A source that cannot be reached, is not JSON, or is older than what is already held changes
 * nothing: the answer is then exactly what it would have been without this file.
 */
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(path.join(PUBLIC, file), 'utf8')); } catch { return null; } };
const usable = (l) => Boolean(l && typeof l === 'object' && l.pairs && typeof l.pairs === 'object' && !Array.isArray(l.pairs));
const newer = (a, b) => (Date.parse(a?.publishedAt) || 0) > (Date.parse(b?.publishedAt) || 0);

let held;            // the ledger currently believed
let checkedAt = 0;   // when the published copy was last asked for

/** The ledger held right now — bundled, or a newer published one fetched earlier. Never waits. */
function current() {
  if (held === undefined) { const l = readJson('watched-releases.json'); held = usable(l) ? l : null; }
  return held;
}

/**
 * The ledger, after asking for a fresher one if it has been a while. Waits at most `timeoutMs`.
 * @param {{ fetchImpl?: Function, now?: () => number, timeoutMs?: number, source?: object|null }} [o]
 */
async function fresh({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 2500, source } = {}) {
  const have = current();
  if (now() - checkedAt < TTL_MS) return have;
  checkedAt = now();
  const src = source === undefined ? readJson('live-source.json') : source;
  const url = src && typeof src.watchedReleases === 'string' && /^https:\/\//.test(src.watchedReleases) ? src.watchedReleases : null;
  if (!url || typeof fetchImpl !== 'function') return have;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return have;
    const text = await res.text();
    if (text.length > MAX_BYTES) return have;
    const got = JSON.parse(text);
    if (usable(got) && newer(got, have)) held = got;
  } catch { /* unreachable or not JSON: what is held stands */ }
  return held;
}

/** For tests: forget what is held and when it was last checked. */
function reset(ledger) { held = ledger; checkedAt = 0; }

module.exports = { current, fresh, reset, TTL_MS };
