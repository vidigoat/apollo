#!/usr/bin/env node
/**
 * Interrogate a package: watch it under decoy environments and report what it hides.
 *
 *   node scripts/interrogate.js --demo         # a planted synthetic stealer, caught red-handed
 *   node scripts/interrogate.js <dir>          # a package directory on disk (must be require-able)
 *
 * Runs LOCALLY and CONTAINED, never on Nebius: Nebius's AUP forbids running malicious code or any
 * egress, and suspected code is exactly what this is for. Contained means a package that reaches for
 * a planted decoy and tries to send it is recorded doing so and stopped before a byte leaves.
 *
 * The --demo sample is authored in this repo (interrogate/sample-stealer/), not real malware: it
 * only acts on a CI runner, reads a token from the environment, and tries to POST it out. Bare, it
 * does nothing; under the CI provocation it is caught with the token in its hand — and the listener
 * a real machine would have, gets nothing.
 */

require('../env').loadEnv();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../observe/probe');
const { interrogate } = require('../interrogate');
const { PROVOCATIONS, CANARY } = require('../interrogate/provocations');
const { rankProvocations } = require('../interrogate/rank');

const args = process.argv.slice(2);
const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', amber: '', dim: '', bold: '', off: '' };

/**
 * Run the REAL probe on a package directory under one provocation, in a child process so the decoy
 * environment and the planted HOME are the package's, not ours. Always contained. This is the local
 * runner the engine calls — the sandbox path (adapters/contree.js) is for the benign popular
 * packages of the normal watch, never for suspected code.
 */
function runInChild({ pkgDir, pkgName, provocation }) {
  const branch = fs.mkdtempSync(path.join(os.tmpdir(), 'interro-'));
  const home = path.join(branch, '.home');
  for (const [rel, content] of Object.entries(provocation.files || {})) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const runner = path.join(branch, 'runner.js');
  const out = path.join(branch, 'report.json');
  fs.writeFileSync(runner, `
const { install } = require(${JSON.stringify(path.join(__dirname, '..', 'observe', 'probe.js'))});
const p = install();
try { require(${JSON.stringify(pkgDir)}); } catch (e) {}
setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(p.seen)); process.exit(0); }, 400);
`);
  const env = { ...process.env, ...(provocation.env || {}), HOME: home, STAKEOUT_CONTAINED: '1', STAKEOUT_CANARY: CANARY };
  const { execFileSync } = require('node:child_process');
  try { execFileSync(process.execPath, [runner], { env, timeout: 15000, stdio: 'ignore' }); } catch { /* a crash still leaves a report, or none */ }
  let observed = null;
  try { observed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { observed = null; }
  fs.rmSync(branch, { recursive: true, force: true });
  return { raw: observed };
}

(async () => {
  let pkgDir;
  let pkgName;
  if (args.includes('--demo')) {
    pkgDir = path.join(__dirname, '..', 'interrogate', 'sample-stealer');
    pkgName = 'sample-stealer (synthetic — authored in this repo, not real malware)';
  } else {
    pkgDir = path.resolve(args.find((a) => !a.startsWith('--')) || '');
    if (!pkgDir || !fs.existsSync(pkgDir)) { console.error('\n  Usage: node scripts/interrogate.js --demo   |   node scripts/interrogate.js <package dir>\n'); process.exit(2); }
    pkgName = path.basename(pkgDir);
  }

  console.log(`\n  ${C.bold}interrogating ${pkgName}${C.off}`);
  console.log(`  ${C.dim}local, contained — a decoy is watched being read and stopped before it leaves${C.off}\n`);

  const runOneImpl = async ({ provocation }) => runInChild({ pkgDir, pkgName, provocation });
  const report = await interrogate({ pkg: pkgName, version: 'on-disk', runOneImpl, provocations: PROVOCATIONS });

  // Nemotron's ordering, printed for the record (does not change what is run — all are run).
  const ranked = await rankProvocations({ pkg: pkgName, baseline: report.baseline }).catch(() => null);
  if (ranked && !ranked.simulated) console.log(`  ${C.dim}Nemotron would try, in order: ${ranked.order.map((o) => o.id).join(' → ')}${C.off}\n`);

  console.log(`  baseline (bare sandbox): ${Object.entries(report.baseline.channels).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(', ') || 'nothing'}  ·  contained: ${report.baseline.contained}\n`);

  if (!report.findings.length) {
    console.log(`  ${C.green}Nothing hidden: it behaved the same under every provocation.${C.off}\n`);
  } else {
    for (const f of report.findings) {
      console.log(`  ${f.stoleDecoy ? C.red + 'CAUGHT' : C.amber + 'new   '}${C.off} under ${C.bold}${f.provocation}${C.off}`);
      console.log(`         ${C.dim}${f.condition}${C.off}`);
      if (f.stoleDecoy) console.log(`         ${C.red}tried to send a planted decoy — and nothing left the box${C.off}`);
      for (const [ch, items] of Object.entries(f.newBehaviour)) console.log(`         + ${ch}: ${items.slice(0, 3).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}`);
    }
    console.log(`\n  ${report.decoyStolen ? C.red + 'A decoy was exfiltrated (contained).' : C.amber + 'Behaviour changed under provocation.'}${C.off}\n`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
