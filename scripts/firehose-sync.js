#!/usr/bin/env node
/**
 * Publish the live watch's record where the site can read it between deploys.
 *
 *   node scripts/firehose-sync.js                 # every 10 minutes, until stopped
 *   node scripts/firehose-sync.js --once
 *
 * The watcher runs on one machine and the site is a static deploy, so "live" was only as live as
 * the last deploy. This pushes the two small files the site reads — the summary and the ledger of
 * watched release pairs — to the gist named in public/live-source.json, through the `gh` CLI
 * (already signed in; no token is read or stored here). The site prefers whichever copy is newer
 * and says when it was written, so a stopped sync shows as an old timestamp, not as a fresh page.
 *
 * It publishes only what the site already shows publicly. The proper home for this is the Nebius
 * Serverless job with Object Storage (deploy/nebius); this is the bridge until that runs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summarise, ledger } = require('./firehose-publish');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DIR = path.resolve(flag('state', path.join(ROOT, 'local', 'firehose')));
const EVERY_MS = Math.max(60, Number(flag('every', 600))) * 1000;

function push() {
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'live-source.json'), 'utf8'));
  if (!/^[0-9a-f]{20,40}$/.test(String(source.gist || ''))) throw new Error('public/live-source.json names no gist');
  const sum = summarise(DIR);
  const body = { files: { 'live-watch.json': { content: JSON.stringify(sum) }, 'watched-releases.json': { content: JSON.stringify(ledger(DIR)) } } };
  const tmp = path.join(os.tmpdir(), `apollo-sync-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  try { execFileSync('gh', ['api', '-X', 'PATCH', `gists/${source.gist}`, '--input', tmp, '--silent'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 }); }
  finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
  return sum;
}

function once() {
  try {
    const s = push();
    console.log(`  ${new Date().toISOString()}  published: ${s.releasesWatched} watched, ${s.caught} moved, ${s.lookalikes.found} lookalikes`);
  } catch (e) {
    // A failed push is not fatal: the next one carries everything this one would have.
    console.log(`  ${new Date().toISOString()}  not published: ${String(e.stderr || e.message).split('\n')[0].slice(0, 160)}`);
  }
}

if (require.main === module) {
  once();
  if (!args.includes('--once')) setInterval(once, EVERY_MS);
}
module.exports = { push };
