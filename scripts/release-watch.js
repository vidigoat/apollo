#!/usr/bin/env node
/**
 * The latest release of the most-used packages, watched against the release before it.
 *
 *   node scripts/release-watch.js --top 200 --concurrency 20      # in Nebius Token Factory Sandboxes
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
 * Ranking covers unscoped names only: npm's bulk downloads endpoint refuses scoped ones, and a
 * request per scoped package is a load on npm this does not need to impose. That is a stated gap,
 * not a hidden one — the record says so.
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

async function weeklyDownloads(names, fetchImpl = fetch) {
  const out = new Map();
  const unscoped = names.filter((n) => !n.startsWith('@'));
  for (let i = 0; i < unscoped.length; i += 128) {
    const chunk = unscoped.slice(i, i + 128);
    const res = await fetchImpl(`https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`);
    if (!res.ok) continue;
    const json = await res.json();
    for (const [n, v] of Object.entries(json)) if (v && Number.isFinite(v.downloads)) out.set(n, v.downloads);
  }
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

module.exports = { lastTwo, weeklyDownloads, gained };

if (require.main === module) {
  (async () => {
    const top = Number(flag('top', 200));
    const concurrency = Math.max(1, Math.min(24, Number(flag('concurrency', 20))));
    const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'index.json'), 'utf8'));
    const names = Object.keys(pub.packages);

    const record = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { results: {} };
    const downloads = await weeklyDownloads(names);
    const ranked = [...downloads.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    console.log(`\n  ${names.length} packages in the index · ${downloads.size} unscoped ranked · watching the top ${ranked.length}`);

    const jobs = [];
    for (const [name, dl] of ranked) {
      const two = lastTwo(await packument(name));
      if (!two) continue;
      const key = `${name}@${two[0]}→${two[1]}`;
      if (record.results[key]) continue;
      jobs.push({ name, dl, from: two[0], to: two[1], key });
    }
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
    save();
    console.log(`\n  ${JSON.stringify(record.tally)} · recorded in docs/release-watch.json\n`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
