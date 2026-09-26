#!/usr/bin/env node
/**
 * Is the watch alive, and keeping up? From its heartbeat — the local one, or the mirrored one.
 *
 *   node scripts/firehose-health.js                 # local/firehose/heartbeat.json
 *   node scripts/firehose-health.js --mirror        # the copy in STAKEOUT_STATE_S3 (a job elsewhere)
 *
 * Exits 1, with the reason, when any of these is true — each is how a watcher fails quietly:
 *   - the heartbeat is older than 10 minutes          it has stopped (a poll is every 15 s)
 *   - it is more than 20,000 changes behind npm        it is running and losing (≈ an hour and a half)
 *   - a due release has waited more than an hour       it is reading and not watching
 */

require('../env').loadEnv();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Mirror } = require('../firehose/mirror');

const LIMITS = { staleMinutes: 10, behind: 20000, waitingMinutes: 60 };

function judge(hb, now = Date.now()) {
  const problems = [];
  const age = (now - Date.parse(hb.at)) / 60000;
  if (!Number.isFinite(age) || age > LIMITS.staleMinutes) problems.push(`the last heartbeat was ${Number.isFinite(age) ? Math.round(age) : '?'} min ago`);
  if (Number.isFinite(hb.behind) && hb.behind > LIMITS.behind) problems.push(`${hb.behind} changes behind npm`);
  if (hb.due > 0 && hb.oldestPendingMinutes > LIMITS.waitingMinutes) problems.push(`a due release has waited ${hb.oldestPendingMinutes} min`);
  return { healthy: problems.length === 0, problems, ageMinutes: Math.round(age * 10) / 10 };
}

module.exports = { judge, LIMITS };

if (require.main === module) {
  (async () => {
    let hb;
    if (process.argv.includes('--mirror')) {
      const m = Mirror.fromEnv();
      if (!m) throw new Error('--mirror needs STAKEOUT_STATE_S3 and its keys');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firehose-health-'));
      await m.restore(dir);
      hb = JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8'));
    } else {
      hb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local', 'firehose', 'heartbeat.json'), 'utf8'));
    }
    const v = judge(hb);
    console.log(`  ${v.healthy ? 'healthy' : 'UNHEALTHY'}  heartbeat ${v.ageMinutes} min ago on ${hb.host} · seq ${hb.seq}${hb.behind !== null ? ` (${hb.behind} behind npm)` : ''} · ${hb.pending} waiting · ${hb.done} done${v.problems.length ? `\n  ${v.problems.join('\n  ')}` : ''}`);
    process.exitCode = v.healthy ? 0 : 1;
  })().catch((e) => { console.error(`  cannot tell: ${e.message}`); process.exit(2); });
}
