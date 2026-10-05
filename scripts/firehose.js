#!/usr/bin/env node
/**
 * Apollo Live: follow npm's change feed and watch every new stable release of the packages real
 * lockfiles depend on, in Nebius Token Factory Sandboxes, as it is published.
 *
 *   node scripts/firehose.js --dry --hours 1          # follow the feed and select; run nothing
 *   node scripts/firehose.js --hours 24               # and watch each release (10 pairs at once)
 *   node scripts/firehose.js --status                 # where it is, what it has found
 *   node scripts/firehose.js --since <seq> --published-since <ISO> --state <dir>   # a backfill
 *
 * State lives in local/firehose/ (gitignored): the feed position, the queue, and two append-only
 * logs — results.jsonl and lookalikes.jsonl. Stop it any time and start it again: it resumes from
 * the position it saved, so nothing published in between is missed, only seen later.
 *
 * There is no simulated mode. A run of this script is either watching npm for real or not running:
 * a simulated watch writing into the same record is how the sibling index once had 8,623
 * fabricated entries written over 705 real ones.
 *
 * Brand-new packages that imitate popular names are described from their metadata and NEVER run —
 * see firehose/select.js for why.
 */

require('../env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { Queue } = require('../firehose/queue');
const { currentSeq } = require('../firehose/feed');
const { pollOnce, workOnce } = require('../firehose');
const { lookalikeIndex } = require('../firehose/select');
const { Mirror } = require('../firehose/mirror');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DIR = path.resolve(flag('state', path.join(ROOT, 'local', 'firehose')));
const mirror = Mirror.fromEnv();
let q = new Queue(DIR);

/** The watched population and how much each is downloaded — the index's names, the release watch's counts. */
function population() {
  const names = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'index.json'), 'utf8')).packages);
  const watch = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'release-watch.json'), 'utf8'));
  const dl = new Map();
  for (const r of Object.values(watch.results)) if (Number.isFinite(r.weeklyDownloads)) dl.set(r.pkg, r.weeklyDownloads);
  return new Map(names.map((n) => [n, dl.get(n) ?? null]));
}

function printStatus() {
  const s = q.status();
  const c = s.counts;
  console.log(`  ${new Date().toISOString().slice(0, 19)}Z  seq ${s.seq}  ·  ${c.changes || 0} changes read  ·  ${c['watched-changed'] || 0} watched changed  ·  ` +
    `${c['releases-found'] || 0} releases queued  ·  ${s.done} done (${c['outcome:watched'] || 0} watched, ${c['outcome:unobserved'] || 0} not watched, ${c['outcome:failed'] || 0} failed)  ·  ` +
    `${s.pending} waiting (${s.due} due, oldest ${s.oldestPendingMinutes} min)  ·  ${s.running} running  ·  ${c.lookalikes || 0} lookalikes  ·  ${s.unread} unreadable`);
}

if (args.includes('--status')) {
  printStatus();
  process.exit(0);
}

(async () => {
  // On a Serverless Job the directory starts empty: bring the watch back before anything else, so a
  // new job continues the old one rather than starting a second watch from "now".
  if (mirror) {
    const got = await mirror.restore(DIR);
    if (got) { q = new Queue(DIR); console.log(`  restored ${got} file(s) of the watch from ${process.env.APOLLO_STATE_S3}`); }
  }
  const dry = args.includes('--dry');
  const hours = Number(flag('hours', 24));
  const concurrency = Math.max(1, Math.min(12, Number(flag('concurrency', 10))));
  const stopAt = Date.now() + hours * 3600 * 1000;
  const pop = population();
  // Imitations are of names worth imitating: the most-downloaded of the watched population.
  const targets = [...pop.entries()].filter(([, d]) => d).sort((a, b) => b[1] - a[1]).slice(0, 2000).map(([n]) => n);
  const lookIdx = lookalikeIndex(targets);

  if (!Number.isFinite(q.state.seq)) {
    const since = flag('since', 'now');
    q.state.seq = since === 'now' ? await currentSeq() : Number(since);
    // `--published-since <ISO>` with `--since <seq>`: a backfill — catching up on what was published
    // while nothing was watching. Without it, only what is published from now on counts.
    const from = flag('published-since', null);
    if (from && !Number.isFinite(Date.parse(from))) throw new Error(`--published-since is not a date: ${from}`);
    q.state.startedAt = from ? new Date(from).toISOString() : new Date().toISOString();
    q.save();
    console.log(`  new watch from seq ${q.state.seq} — releases published from ${q.state.startedAt} on`);
  } else {
    const back = q.recover();
    console.log(`  resuming at seq ${q.state.seq} (watching since ${q.state.startedAt})${back ? ` — ${back} interrupted job(s) put back` : ''}`);
  }
  console.log(`  ${pop.size} packages watched · ${targets.length} lookalike targets · ${dry ? 'DRY: selecting only, nothing runs' : `${concurrency} pairs at once in Nebius Sandboxes`} · until ${new Date(stopAt).toISOString()}\n`);

  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; console.log('\n  stopping: finishing the pairs in flight, taking no new ones'); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Hourly counts, appended, so a day's watch can be read as a day and not only as a total.
  let hourMark = Date.now();
  let lastCounts = { ...q.state.counts };
  const hourly = () => {
    if (Date.now() - hourMark < 3600 * 1000) return;
    const delta = {};
    for (const [k, v] of Object.entries(q.state.counts)) if (v - (lastCounts[k] || 0)) delta[k] = v - (lastCounts[k] || 0);
    fs.appendFileSync(path.join(DIR, 'hours.jsonl'), `${JSON.stringify({ from: new Date(hourMark).toISOString(), to: new Date().toISOString(), ...delta, status: q.status() })}\n`);
    hourMark = Date.now();
    lastCounts = { ...q.state.counts };
  };

  /*
   * A heartbeat after every poll: when, where in the feed, how far behind npm, and the queue. It is
   * what scripts/firehose-health.js reads — a watcher that has quietly stopped looks exactly like a
   * quiet day on npm, and the only difference is the time on this file.
   */
  let head = null;
  let headAt = 0;
  const beat = async () => {
    if (Date.now() - headAt > 5 * 60 * 1000) {
      try { head = await currentSeq(); headAt = Date.now(); } catch { /* the next beat asks again */ }
    }
    const st = q.status();
    fs.writeFileSync(path.join(DIR, 'heartbeat.json'), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, host: require('node:os').hostname(), dry, seq: st.seq, head, behind: head === null ? null : Math.max(0, head - st.seq), pending: st.pending, due: st.due, running: st.running, done: st.done, unread: st.unread, oldestPendingMinutes: st.oldestPendingMinutes, watchingSince: q.state.startedAt })}\n`);
    if (mirror) {
      const r = await mirror.push(DIR);
      if (r.failed?.length) console.log(`  mirror: ${r.failed.join('; ').slice(0, 200)} — trying again next minute`);
    }
  };

  const poller = (async () => {
    let failures = 0;
    while (!stopping && Date.now() < stopAt) {
      try {
        const r = await pollOnce(q, { population: pop, lookIdx });
        failures = 0;
        hourly();
        await beat();
        if (!r.full) await new Promise((res) => setTimeout(res, 15000));
      } catch (e) {
        // The feed or the registry being down is waited out and said; the position is untouched.
        failures++;
        console.log(`  feed: ${String(e.message).slice(0, 160)} — trying again in ${Math.min(300, 15 * failures)} s`);
        await new Promise((res) => setTimeout(res, Math.min(300, 15 * failures) * 1000));
      }
    }
  })();

  const status = setInterval(printStatus, 60000);
  let workers = [];
  if (!dry) {
    const { ConTreeSandboxes } = require('../adapters/contree');
    const { runPair } = require('../runPair');
    const { bestStrategy } = require('../observe');
    const { summarise } = require('../differ/diff');
    const adapter = new ConTreeSandboxes({ image: 'docker.io/library/node:22-slim' });
    let checkpoint = await adapter.boot();
    const strategy = bestStrategy(adapter);
    let streak = 0;
    const worker = async () => {
      while (!stopping && Date.now() < stopAt) {
        const r = await workOnce(q, { adapter, checkpoint, strategy, runPairImpl: runPair, summarise }).catch((e) => ({ outcome: 'crashed', error: e.message }));
        if (!r) { await new Promise((res) => setTimeout(res, 5000)); continue; }
        if (r.outcome === 'watched') {
          streak = 0;
          console.log(`  ${String(r.severity).padEnd(8)} ${r.key}  ${r.minutesPublishToVerdict} min after publish${r.signals?.length ? `  signals: ${r.signals.map((s) => s.signal).join(', ')}` : ''}`);
        } else {
          console.log(`  ${r.outcome.padEnd(8)} ${r.key}  ${String(r.error || '').slice(0, 120)}`);
          // Several failures in a row that are not the package's fault look like our checkpoint has
          // gone stale (a long run outlives an image reference); make a fresh one rather than
          // recording a morning of "failed".
          if (r.outcome === 'failed' || r.outcome === 'crashed') {
            if (++streak >= 3) {
              console.log('  three failures in a row: booting a fresh checkpoint');
              try { checkpoint = await adapter.boot(); streak = 0; } catch (e) { console.log(`  boot failed: ${e.message}`); await new Promise((res) => setTimeout(res, 60000)); }
            }
          }
        }
      }
    };
    workers = Array.from({ length: concurrency }, worker);
  }

  await Promise.all([poller, ...workers]);
  clearInterval(status);
  hourly();
  printStatus();
  q.save();
  await beat().catch(() => {});
  if (mirror) {
    const r = await mirror.push(DIR, { force: true });
    console.log(`  mirror: ${r.failed?.length ? `FAILED ${r.failed.join('; ')}` : `pushed ${r.pushed?.length || 0} file(s)`}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
