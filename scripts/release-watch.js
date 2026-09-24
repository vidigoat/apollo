#!/usr/bin/env node
/**
 * The latest release of the most-used packages, watched against the release before it.
 *
 *   node scripts/release-watch.js --top 200 --concurrency 20      # in Nebius Token Factory Sandboxes
 *   node scripts/release-watch.js --top 1000 --explain            # and the ones that moved, explained
 *
 * `survey.js` asks the baseline question over a fixed list of pairs. This asks the live one: of the
 * packages the index already holds, rank by weekly downloads, take each one's newest release and the
 * release before it, and watch both — two sandboxes forked from one checkpoint, as everywhere else.
 * The differ's rules decide severity; no model is called, so a run costs sandbox time and nothing
 * else.
 *
 * What it is for: if a popular package's newest release does something its last one did not, this
 * is where it shows up — and if none does, that is a baseline with a date on it. Nothing is selected
 * for being interesting. Results land in docs/release-watch.json and a re-run skips pairs it has.
 *
 * npm's bulk downloads endpoint refuses scoped names, so they are ranked only with `--scoped N`,
 * one request per package, four at a time — and the record says which ranking it used.
 */

require('../env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { runPair } = require('../runPair');
const { bestStrategy } = require('../observe');
const { summarise } = require('../differ/diff');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'release-watch.json');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const cmp = (a, b) => { const x = STABLE.exec(a).slice(1).map(Number); const y = STABLE.exec(b).slice(1).map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

/** The newest stable release and the stable release before it, or null. */
function lastTwo(meta) {
  const latest = meta?.['dist-tags']?.latest;
  if (!latest || !STABLE.test(latest)) return null;
  const prior = Object.keys(meta.versions || {}).filter((v) => STABLE.test(v) && cmp(v, latest) < 0).sort(cmp).pop();
  return prior ? [prior, latest] : null;
}

/**
 * Weekly downloads for every unscoped name, 128 to a request.
 *
 * A chunk that failed used to be skipped without a word — and after a burst of requests npm answers
 * 429, so a ranking of 384 names out of 3,931 went on to be called "the most-downloaded". A 429 is
 * now waited out; a chunk that still fails stops the ranking, because a partial ranking is not a
 * smaller version of the right answer, it is a different and wrong one.
 */
async function weeklyDownloads(names, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const out = new Map();
  const unscoped = names.filter((n) => !n.startsWith('@'));
  for (let i = 0; i < unscoped.length; i += 128) {
    const chunk = unscoped.slice(i, i + 128);
    let json = null;
    for (let attempt = 0; attempt < 6 && !json; attempt++) {
      const res = await fetchImpl(`https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`).catch(() => null);
      if (res?.ok) json = await res.json();
      else await sleep(2000 * 2 ** attempt);
    }
    if (!json) throw new Error(`npm's downloads API would not rank names ${i + 1}–${i + chunk.length}; refusing to call a partial ranking "the most-downloaded"`);
    for (const [n, v] of Object.entries(json)) if (v && Number.isFinite(v.downloads)) out.set(n, v.downloads);
    await sleep(300);
  }
  return out;
}

/**
 * Scoped names one at a time — npm's bulk endpoint refuses them — four in flight at most, and only
 * when asked for (`--scoped N`), because it is one request per package against a public API.
 */
async function scopedDownloads(names, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), { candidates = Infinity, heldVersions = null } = {}) {
  const out = new Map();
  // npm's downloads API refuses after a few quick requests, so ranking every scoped name one by
  // one is half an hour. The candidates are narrowed first by how many versions the index holds —
  // it is built from lockfiles, so that tracks how many projects depend on a package — and only
  // those are asked about.
  let scoped = names.filter((n) => n.startsWith('@') && !n.startsWith('@types/'));
  if (heldVersions) scoped = scoped.sort((a, b) => (heldVersions[b] || 0) - (heldVersions[a] || 0));
  scoped = scoped.slice(0, candidates);
  let next = 0;
  // The first run asked four at a time and dropped every 429 without a word: 12 of ~1,700 came back
  // ranked, and the watch would have looked at those as if they were the most-used. A 429 now waits
  // and asks again, and how many were ranked out of how many asked is returned, not hidden.
  const worker = async () => {
    while (next < scoped.length) {
      const n = scoped[next++];
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await fetchImpl(`https://api.npmjs.org/downloads/point/last-week/${n}`);
          if (res.status === 429 || res.status >= 500) { await sleep(1500 * 2 ** attempt); continue; }
          if (res.ok) { const j = await res.json(); if (Number.isFinite(j.downloads)) out.set(n, j.downloads); }
          await sleep(250);
          break;
        } catch { await sleep(1000); }
      }
    }
  };
  await Promise.all(Array.from({ length: 1 }, async () => { await worker(); }));
  out.asked = scoped.length;
  return out;
}

async function packument(name, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  return res.ok ? res.json() : null;
}

/** What a diff gained, per channel, as short strings — the part a person reads. */
function gained(d) {
  const out = {};
  for (const c of ['net', 'dns', 'fs', 'env', 'proc', 'exec']) {
    const added = (d[c]?.added || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 120));
    const removed = (d[c]?.removed || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 120));
    if (added.length || removed.length) out[c] = { added, removed };
    const ia = (d.install?.[c]?.added || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 120));
    if (ia.length) out[`install.${c}`] = { added: ia, removed: (d.install[c].removed || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 120)) };
  }
  return out;
}

/**
 * What the site needs from the record: how many were watched and stayed the same, and every pair
 * that did not. The full record — every unchanged pair too — stays in docs/release-watch.json; the
 * page was downloading all of it (325 kB at 1,287 pairs) to draw thirteen rows.
 */
function slim(record) {
  const all = Object.values(record.results || {});
  const tally = all.reduce((t, r) => ((t[r.severity] = (t[r.severity] || 0) + 1), t), {});
  return {
    measured: record.measured,
    strategy: record.strategy,
    ranking: record.ranking,
    scoped: record.scoped,
    notes: record.notes,
    total: all.length,
    tally,
    results: Object.fromEntries(Object.entries(record.results || {}).filter(([, r]) => r.severity !== 'none')),
  };
}

module.exports = { lastTwo, weeklyDownloads, scopedDownloads, gained, slim };

// `--publish-only`: rewrite the site's slim copy from the full record, and nothing else.
if (require.main === module && args.includes('--publish-only')) {
  const record = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  fs.writeFileSync(path.join(ROOT, 'public', 'release-watch.json'), `${JSON.stringify(slim(record))}\n`);
  console.log(`  public/release-watch.json: ${Object.keys(slim(record).results).length} of ${Object.keys(record.results).length} pairs`);
  process.exit(0);
}

if (require.main === module) {
  (async () => {
    const top = Number(flag('top', 200));
    const concurrency = Math.max(1, Math.min(24, Number(flag('concurrency', 20))));
    const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'index.json'), 'utf8'));
    const names = Object.keys(pub.packages);

    const record = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { results: {} };
    /*
     * The ranking is cached for a day. It is minutes of npm's downloads API, which answers 429 after
     * a burst — so a restart used to spend a quarter of an hour asking the same question again,
     * and two restarts in a morning were enough to be throttled for the rest of it.
     */
    const scopedTop = Number(flag('scoped', 0));
    const cacheFile = path.join(require('node:os').tmpdir(), `stakeout-release-ranking-${top}-${scopedTop}.json`);
    let cached = null;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - c.at < 24 * 3600 * 1000 && !args.includes('--rerank')) cached = c;
    } catch { /* no cache, or an unreadable one: rank */ }
    let ranked;
    if (cached) {
      ranked = cached.ranked;
      if (cached.scoped) record.scoped = cached.scoped;
      console.log(`  ranking reused from ${new Date(cached.at).toISOString()} (--rerank to ask npm again)`);
    } else {
      const downloads = await weeklyDownloads(names);
      ranked = [...downloads.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
      if (scopedTop) {
        // @types/* is left out: a type declaration has no runtime, so there is nothing to watch.
        const held = Object.fromEntries(Object.entries(pub.packages).map(([n, r]) => [n, Object.keys(r.versions || r).length]));
        const sd = await scopedDownloads(names, fetch, undefined, { candidates: Math.ceil(scopedTop * 1.5), heldVersions: held });
        ranked.push(...[...sd.entries()].sort((a, b) => b[1] - a[1]).slice(0, scopedTop));
        record.scoped = `top ${scopedTop} scoped packages by weekly downloads, among the ${sd.asked} the index holds most versions of (@types/* excluded) — ${sd.size} ranked`;
        console.log(`  ${sd.size} of ${sd.asked} scoped names ranked`);
      }
      try { fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), ranked, scoped: record.scoped || null })); } catch { /* a cache is a convenience */ }
    }
    console.log(`\n  ${names.length} packages in the index · watching ${ranked.length}`);

    // Eight registry reads at a time, in rank order, so a thousand packages is a minute, not ten.
    const metas = new Array(ranked.length);
    let at = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (at < ranked.length) { const i = at++; metas[i] = await packument(ranked[i][0]).catch(() => null); }
    }));
    const jobs = [];
    ranked.forEach(([name, dl], i) => {
      const two = lastTwo(metas[i]);
      if (!two) return;
      const key = `${name}@${two[0]}→${two[1]}`;
      if (record.results[key]) return;
      jobs.push({ name, dl, from: two[0], to: two[1], key });
    });
    console.log(`  ${jobs.length} pairs to watch (${Object.keys(record.results).length} already recorded)\n`);

    const { ConTreeSandboxes } = require('../adapters/contree');
    const adapter = new ConTreeSandboxes({ image: 'docker.io/library/node:22-slim' });
    const checkpoint = await adapter.boot();
    const strategy = bestStrategy(adapter);
    const save = () => {
      const all = Object.values(record.results);
      record.measured = new Date().toISOString();
      record.strategy = strategy;
      record.ranking = 'weekly npm downloads, unscoped packages the published index holds';
      record.tally = all.reduce((t, r) => ((t[r.severity] = (t[r.severity] || 0) + 1), t), {});
      fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
      // The site gets the slim copy — counts, and only the pairs that moved or could not be watched.
      fs.writeFileSync(path.join(ROOT, 'public', 'release-watch.json'), `${JSON.stringify(slim(record))}\n`);
    };

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        const started = Date.now();
        try {
          const { diff: d } = await runPair({ adapter, checkpoint, pkg: j.name, from: j.from, to: j.to, strategy });
          record.results[j.key] = { pkg: j.name, from: j.from, to: j.to, weeklyDownloads: j.dl, severity: d.severity, reasons: d.reasons || [], gained: gained(d), summary: summarise(d), seconds: Math.round((Date.now() - started) / 1000) };
          console.log(`  ${d.severity.padEnd(8)} ${j.key}${d.changed ? `  ${(d.reasons || []).join('; ').slice(0, 110)}` : ''}`);
        } catch (e) {
          // Not watched is its own outcome, recorded as such — never folded into "none".
          record.results[j.key] = { pkg: j.name, from: j.from, to: j.to, weeklyDownloads: j.dl, severity: e.code === 'UNOBSERVED' ? 'unobserved' : 'failed', error: String(e.message).split('\n')[0].slice(0, 200) };
          console.log(`  ${(e.code === 'UNOBSERVED' ? 'unseen' : 'failed').padEnd(8)} ${j.key}  ${String(e.message).split('\n')[0].slice(0, 100)}`);
        }
        save();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    /*
     * `--explain`: the few that moved, read by Nemotron against the public record (Tavily).
     *
     * The rules have already decided severity and nothing here changes it — a model explains, it
     * never escalates. Each moved pair is watched once more so the judge sees the whole diff rather
     * than the summary kept above, the release is looked up on the open web, and judge/index.js
     * runs its usual tiers under its usual spend ceiling (judge/budget.js). Verdicts are cached, so
     * a second --explain costs nothing.
     */
    if (args.includes('--explain')) {
      const { judgeOne } = require('../judge');
      const { lookUp } = require('../evidence/tavily');
      const moved = Object.entries(record.results).filter(([, r]) => ['minor', 'notable', 'alarming'].includes(r.severity) && !r.judgement);
      console.log(`\n  explaining ${moved.length} that moved — Nemotron on Token Factory, public record from Tavily\n`);
      for (const [key, r] of moved) {
        try {
          const { diff: d } = await runPair({ adapter, checkpoint, pkg: r.pkg, from: r.from, to: r.to, strategy });
          const pub = await lookUp(r.pkg, r.to);
          const j = await judgeOne(d, pub);
          r.judgement = {
            tier: j.tier || null,
            meaning: j.verdict?.meaning || null,
            explainedByPublicRecord: j.verdict ? j.verdict.explained : null,
            worthWaking: j.verdict ? j.verdict.worthWaking : null,
            confidence: j.verdict?.confidence || null,
            reason: j.reason,
            record: { verdict: pub.verdict, sources: (pub.sources || []).slice(0, 3), simulated: Boolean(pub.simulated) },
            models: (j.spend || []).map((x) => x.model),
            costUsd: j.costUsd ?? null,
            severityStill: d.severity,
          };
          console.log(`  ${r.severity.padEnd(8)} ${key}  ${j.tier || '-'}: ${(j.verdict?.meaning || j.reason || '').slice(0, 110)}`);
        } catch (e) {
          // A budget stop or a failed call is said, and the finding stands on the rules alone.
          r.judgement = { error: String(e.message).split('\n')[0].slice(0, 200) };
          console.log(`  ${r.severity.padEnd(8)} ${key}  not explained: ${r.judgement.error.slice(0, 100)}`);
        }
        save();
      }
    }
    save();
    console.log(`\n  ${JSON.stringify(record.tally)} · recorded in docs/release-watch.json\n`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
