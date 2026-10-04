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

const RANK = { alarming: 3, notable: 2, minor: 1 };
const LIVE_WINDOW_MIN = 30;

/**
 * A plain reading of WHY a release moved — only where the record itself settles it.
 *
 * One case is mechanical: the release added a dependency (a publish signal, read from the registry)
 * and the processes that newly ran at install are that dependency's own files. Then the new
 * behaviour is the new dependency's install script, and saying so is arithmetic over two recorded
 * facts. Anything else gets no sentence at all — an explanation the record does not carry would be
 * a guess wearing the page's authority, and "alarming" already means *look*, not *malicious*.
 */
function explain(r) {
  const added = (Array.isArray(r.signals) ? r.signals : [])
    .filter((s) => s && s.signal === 'dependencies-added' && typeof s.detail === 'string')
    .flatMap((s) => s.detail.split(/,\s*/)).map((d) => d.trim()).filter(Boolean);
  if (!added.length) return null;
  const procs = (r.gained?.['install.proc']?.added || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  const dep = added.find((d) => procs.some((x) => x.includes(`node_modules/${d}`)));
  return dep ? `${r.to} added a dependency on ${dep}, and what newly runs at install is ${dep}'s own install script.` : null;
}

/** Reduce the watcher's local record in `dir` to the small object the catch page reads. */
function summarise(dir) {
  const results = readLines(dir, 'results.jsonl');
  const lookalikes = readLines(dir, 'lookalikes.jsonl');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { /* no state yet */ }

  const watched = results.filter((r) => r.outcome === 'watched');
  const bySeverity = watched.reduce((t, r) => ((t[r.severity] = (t[r.severity] || 0) + 1), t), {});
  const notWatched = results.filter((r) => r.outcome !== 'watched').reduce((t, r) => ((t[r.outcome] = (t[r.outcome] || 0) + 1), t), {});

  /*
   * "Minutes after publish" is a claim about the watcher WHILE IT IS RUNNING. When it has been down
   * and resumes, it works through everything published in the gap — correctly, nothing is skipped —
   * but those verdicts arrive days after publish, and folding them into one median would either
   * flatter the tool (if left out silently) or bury what it does when it is up (if left in). So the
   * two are counted apart and both are said: a release is "live" when the watcher first saw it
   * within LIVE_WINDOW_MIN of its publish, and "caught up" otherwise.
   */
  const sawLive = (r) => {
    const gap = (Date.parse(r.seenAt) - Date.parse(r.publishedAt)) / 60000;
    return Number.isFinite(gap) ? gap <= LIVE_WINDOW_MIN : Number.isFinite(r.minutesPublishToVerdict) && r.minutesPublishToVerdict <= LIVE_WINDOW_MIN;
  };
  const live = watched.filter(sawLive);
  const times = live.map((r) => r.minutesPublishToVerdict).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;

  // The releases that moved — behaviour changed from the previous version. The evidence a person reads.
  // Most severe first: the one that says "look now" should not be third because nobody knows its
  // download count. Downloads only order releases of the same severity.
  const moved = watched
    .filter((r) => r.severity && r.severity !== 'none')
    .sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0) || (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0))
    .slice(0, 50)
    .map((r) => ({ pkg: r.pkg, from: r.from, to: r.to, severity: r.severity, reasons: r.reasons || [], gained: r.gained || {}, weeklyDownloads: r.weeklyDownloads ?? null, minutesToVerdict: r.minutesPublishToVerdict ?? null, live: sawLive(r), signals: (r.signals || []).map((s) => s.signal), explained: explain(r) }));

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
    watchedLive: live.length,
    caughtUp: watched.length - live.length,
    lookalikes: {
      found: lookalikes.length,
      // A brand-new package imitating a popular name, described from its metadata — never run.
      recent: lookalikes.slice(-30).reverse().map((l) => ({ name: l.name, imitates: l.imitates, kind: l.kind, signals: l.signals || [], seenAt: l.seenAt })),
    },
    counts: state.counts || {},
  };
}

/**
 * Every release pair the watcher ran, keyed for lookup: what the GitHub App checks a bump against.
 *
 * The page needs only the pairs that moved. A pull request needs the others just as much — "this
 * upgrade was watched, old against new, and behaves the same" is an answer nobody else can give,
 * and it is most of what a dependency bot's pull requests deserve to hear.
 */
function ledger(dir) {
  const pairs = Object.create(null);
  for (const r of readLines(dir, 'results.jsonl')) {
    if (!r || r.outcome !== 'watched' || typeof r.pkg !== 'string' || typeof r.from !== 'string' || typeof r.to !== 'string' || !r.severity) continue;
    if (r.pkg === '__proto__' || r.pkg === 'constructor' || r.pkg === 'prototype') continue;
    (pairs[r.pkg] ||= Object.create(null))[`${r.from}→${r.to}`] = {
      severity: r.severity,
      ...(r.severity !== 'none' ? { reasons: r.reasons || [], gained: r.gained || {}, explained: explain(r) } : {}),
      watchedAt: r.doneAt || null,
    };
  }
  return { schema: 1, publishedAt: new Date().toISOString(), count: Object.values(pairs).reduce((n, p) => n + Object.keys(p).length, 0), pairs };
}

if (require.main === module) {
  const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'local', 'firehose'));
  const out = summarise(DIR);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const led = ledger(DIR);
  fs.writeFileSync(path.join(ROOT, 'public', 'watched-releases.json'), `${JSON.stringify(led)}\n`);
  console.log(`  live-watch.json: ${out.releasesWatched} releases watched, ${out.caught} moved, ${out.lookalikes.found} lookalikes` +
    `${out.medianMinutesToVerdict != null ? `, median ${out.medianMinutesToVerdict} min to verdict` : ''}`);
}

module.exports = { summarise, readLines, explain, ledger };
