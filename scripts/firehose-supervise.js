#!/usr/bin/env node
/**
 * Keep the watcher running: start it, and when it dies, start it again.
 *
 *   node scripts/firehose-supervise.js --hours 167 [every other firehose.js flag]
 *
 * This is what a Nebius Serverless Job runs. The watcher already survives what it can foresee —
 * npm answering 429, a packument that will not load, a sandbox failing, a stale checkpoint — but a
 * process can still die of what nobody foresaw, and a job whose one process has exited is a job
 * that is over. So a dead watcher is restarted, after 5 s, then 10, 20 … at most five minutes
 * apart, until the hours are up; each restart resumes from the saved feed position, so a crash
 * costs minutes of lag and never a gap. A watcher that stays up an hour resets the backoff.
 *
 * Every start and every exit is one line on stdout, so the job's log is the history of its health.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const i = args.indexOf('--hours');
const hours = i > -1 ? Number(args[i + 1]) : 24;
const stopAt = Date.now() + hours * 3600 * 1000;
let child = null;
let stopping = false;
let delay = 5000;

function stamp() { return new Date().toISOString().slice(0, 19) + 'Z'; }

function start() {
  if (stopping || Date.now() >= stopAt) return;
  // The watcher is told how long is LEFT, so a restart at hour 100 does not run for another 167.
  const left = Math.max(0.05, (stopAt - Date.now()) / 3600000);
  const rest = args.filter((a, k) => k !== i && k !== i + 1);
  const startedAt = Date.now();
  // STAKEOUT_SUPERVISE_CHILD exists for the test, which supervises a script that crashes on purpose.
  const script = process.env.STAKEOUT_SUPERVISE_CHILD || path.join(__dirname, 'firehose.js');
  const first = process.env.STAKEOUT_SUPERVISE_FIRST_DELAY_MS;
  if (first && delay === 5000) delay = Number(first);
  child = spawn(process.execPath, [script, '--hours', left.toFixed(3), ...rest], { stdio: 'inherit' });
  console.log(`  supervise ${stamp()}  started watcher pid ${child.pid} for ${left.toFixed(1)} h`);
  child.on('exit', (code, signal) => {
    const upFor = Date.now() - startedAt;
    console.log(`  supervise ${stamp()}  watcher exited (code ${code}${signal ? `, ${signal}` : ''}) after ${Math.round(upFor / 1000)} s`);
    child = null;
    if (stopping || Date.now() >= stopAt) return process.exit(code || 0);
    if (code === 0 && !signal && Date.now() >= stopAt - 60000) return process.exit(0);
    if (upFor > 3600 * 1000) delay = 5000;
    console.log(`  supervise ${stamp()}  restarting in ${delay / 1000} s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 5 * 60 * 1000);
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    console.log(`  supervise ${stamp()}  ${sig}: stopping the watcher`);
    if (child) child.kill('SIGTERM'); else process.exit(0);
  });
}

start();
