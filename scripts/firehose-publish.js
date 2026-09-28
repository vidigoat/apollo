#!/usr/bin/env node
/**
 * Turn the live watch's own record into the small file the site's catch page reads.
 *
 *   node scripts/firehose-publish.js            # local/firehose → public/live-watch.json
 *
 * The watcher writes results.jsonl (every release it watched, with timestamps) and lookalikes.jsonl
 * as it runs; those are local and large. This reduces them to what a page needs — how many releases
 * were watched, how fast a verdict came after publish, which ones moved, and the lookalikes found —
 * and nothing a visitor would have to download megabytes for.
 *
 * It reports the honest state, whatever it is. On a quiet week that is "watched N, caught 0", and it
 * says so plainly rather than dressing a clean week as a dramatic one. A page that only looks good
 * when something is on fire is a page that lies the rest of the time.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'live-watch.json');

const readLines = (dir, f) => {
  let text;
  try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return []; }
  // Per line, not all-or-nothing: a crash mid-append leaves a truncated last line, and losing every
  // good line to one bad one would turn a live watch into a page that says "0 watched" — the exact
  // moment the record matters most is the one where a single bad byte must not blank it.
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip a partial/corrupt line */ } }
  return out;
};

/** Reduce the watcher's local record in `dir` to the small object the catch page reads. */
function summarise(dir) {
  const results = readLines(dir, 'results.jsonl');
  const lookalikes = readLines(dir, 'lookalikes.jsonl');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { /* no state yet */ }

  const watched = results.filter((r) => r.outcome === 'watched');
  const bySeverity = watched.reduce((t, r) => ((t[r.severity] = (t[r.severity] || 0) + 1), t), {});
  const notWatched = results.filter((r) => r.outcome !== 'watched').reduce((t, r) => ((t[r.outcome] = (t[r.outcome] || 0) + 1), t), {});

  const times = watched.map((r) => r.minutesPublishToVerdict).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;

  // The releases that moved — behaviour changed from the previous version. The evidence a person reads.
  const moved = watched
    .filter((r) => r.severity && r.severity !== 'none')
    .sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0))
    .slice(0, 50)
    .map((r) => ({ pkg: r.pkg, from: r.from, to: r.to, severity: r.severity, reasons: r.reasons || [], gained: r.gained || {}, weeklyDownloads: r.weeklyDownloads ?? null, minutesToVerdict: r.minutesPublishToVerdict ?? null, signals: (r.signals || []).map((s) => s.signal) }));

  return {
    publishedAt: new Date().toISOString(),
    watchingSince: state.startedAt || (watched[0] && watched[0].seenAt) || null,
    seq: state.seq ?? null,
    packagesWatched: state.watermarks ? Object.keys(state.watermarks).length : null,
    releasesWatched: watched.length,
    bySeverity,
    moved,
    caught: moved.length,
    notWatched,
    medianMinutesToVerdict: median,
    lookalikes: {
      found: lookalikes.length,
      // A brand-new package imitating a popular name, described from its metadata — never run.
      recent: lookalikes.slice(-30).reverse().map((l) => ({ name: l.name, imitates: l.imitates, kind: l.kind, signals: l.signals || [], seenAt: l.seenAt })),
    },
    counts: state.counts || {},
  };
}

if (require.main === module) {
  const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'local', 'firehose'));
  const out = summarise(DIR);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.log(`  live-watch.json: ${out.releasesWatched} releases watched, ${out.caught} moved, ${out.lookalikes.found} lookalikes` +
    `${out.medianMinutesToVerdict != null ? `, median ${out.medianMinutesToVerdict} min to verdict` : ''}`);
}

module.exports = { summarise, readLines };
