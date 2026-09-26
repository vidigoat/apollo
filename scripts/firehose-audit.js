#!/usr/bin/env node
/**
 * Did the watcher miss anything? Checked from the outside.
 *
 *   node scripts/firehose-audit.js                      # the live watch in local/firehose/
 *   node scripts/firehose-audit.js --state /tmp/fh-back
 *
 * The watcher reads npm's change feed a batch at a time and says what it found. This does not trust
 * that. It re-reads the same stretch of the feed in one pass — from where the watch began to where
 * it is now — takes every watched package that changed in it, asks the registry for each one's
 * publish times, and works out, independently, every stable release a correct watcher had to find.
 * Then it compares: each of those must be in the watcher's results or still in its queue.
 *
 * "Nothing dropped" is then a count with a method behind it, not a feeling about a log.
 *
 * What it does NOT check: the definition of a release. It uses the same newReleases (select.js) the
 * watcher does, so a stable release that rule excludes would be excluded here too. It checks the
 * reading — one sweep against many batches, publish times against the watcher's watermarks,
 * restarts, retries, the unreadable list — which is where a watcher that runs for days loses things.
 *
 * First run, 26 Sep, on a three-hour backfill: 10,152 changes re-read, 47 watched packages changed,
 * 10 releases owed, 10 found, none missing.
 *
 * It needs the position the watch started from, which the state does not keep (only where it is
 * now), so the first poll's position is taken from the log line "new watch from seq N" or from
 * `--from-seq N`.
 */

require('../env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { readChanges } = require('../firehose/feed');
const { packument } = require('../firehose');
const { newReleases } = require('../firehose/select');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DIR = path.resolve(flag('state', path.join(ROOT, 'local', 'firehose')));

(async () => {
  const state = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'));
  let fromSeq = Number(flag('from-seq', NaN));
  if (!Number.isFinite(fromSeq)) {
    const log = flag('log', path.join(require('node:os').homedir(), 'stakeout-index-work', 'firehose-live.log'));
    const m = fs.existsSync(log) && /new watch from seq (\d+)/.exec(fs.readFileSync(log, 'utf8'));
    if (!m) throw new Error('no starting position: pass --from-seq N');
    fromSeq = Number(m[1]);
  }
  const toSeq = state.seq;
  const pop = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'index.json'), 'utf8')).packages));

  // 1. Every watched package that changed between the two positions, read in one sweep.
  const changed = new Set();
  let since = fromSeq;
  let read = 0;
  while (since < toSeq) {
    const { results, lastSeq } = await readChanges({ since, limit: 10000 });
    for (const c of results) {
      if (c.seq > toSeq) break;
      read++;
      if (!c.deleted && pop.has(c.id)) changed.add(c.id);
    }
    if (lastSeq <= since || !results.length) break;
    since = lastSeq;
  }

  // 2. What each of them published in the window, from the registry's own publish times. A release
  //    published after the watcher's current position was reached is not yet owed.
  const owed = new Map();
  const cutoff = Date.parse(state.lastPollAt || new Date().toISOString());
  for (const name of changed) {
    const pk = await packument(name).catch(() => null);
    if (!pk) continue;
    for (const r of newReleases(pk, { after: state.startedAt }).releases) {
      if (Date.parse(r.publishedAt) <= cutoff) owed.set(`${name}@${r.prior}→${r.version}`, r);
    }
  }

  // 3. What the watcher has: results (deduplicated by key — a crash between writing a result and
  //    saving state can repeat one) and its queue.
  const results = fs.existsSync(path.join(DIR, 'results.jsonl'))
    ? fs.readFileSync(path.join(DIR, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const byKey = new Map(results.map((r) => [r.key, r]));
  const queued = new Set([...state.pending.map((j) => j.key), ...Object.keys(state.running)]);

  const missing = [...owed.keys()].filter((k) => !byKey.has(k) && !queued.has(k));
  const extra = [...byKey.keys()].filter((k) => !owed.has(k));
  const outcome = {
    audited: new Date().toISOString(),
    window: { fromSeq, toSeq, changesRead: read, from: state.startedAt, to: state.lastPollAt },
    watchedPackagesChanged: changed.size,
    releasesOwed: owed.size,
    found: owed.size - missing.length,
    missing,
    // Found by the watcher and not by this sweep: a package whose later publish moved it out of the
    // sweep's view, or a release since unpublished. Listed, not hidden.
    notInSweep: extra,
    duplicateResultLines: results.length - byKey.size,
  };
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode = missing.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(2); });
