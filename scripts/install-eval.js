#!/usr/bin/env node
/**
 * What do real install scripts do when they are run in a box with nothing to reach?
 *
 *   node scripts/install-eval.js                         # the synthetic corpus (proof/corpus-install)
 *   node scripts/install-eval.js --dataset <dir> --i-have-a-throwaway-machine [--limit N] [--concurrency N]
 *
 * Each sample's own lifecycle scripts are run in a locked-down container (proof/harden.js: no
 * network, read-only root, no capabilities, nothing of the host but the sample, read-only), bare
 * first. A sample that shows nothing strong is then interrogated — run again under each decoy
 * environment (a CI runner with a publish token, cloud credentials, a wallet, a clock moved months
 * on) — because a stealer that waits for a token does nothing on a machine without one.
 *
 * It reports what was observed, in separate columns, and does not roll them into one score:
 * how many ran an install script at all, how many read a credential, ran a downloader, took a
 * decoy, or only reached for the network. Beside them it prints the same rates measured on the
 * real registry's most-used packages (docs/install-phase.json), because "9 in 10 malicious
 * packages read a credential at install" means nothing until you know how many honest ones do.
 *
 * A `--dataset` is REAL malware and is refused without the flag: run it on a machine you can
 * destroy, never a personal one, and never on Nebius (its AUP forbids it).
 */

const fs = require('node:fs');
const path = require('node:path');
const { runContained, dockerAvailable } = require('../proof/harden');
const { installVerdict } = require('../proof/install-verdict');
const { stolenDecoy } = require('../interrogate');
const { PROVOCATIONS, CANARY } = require('../interrogate/provocations');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', amber: '', dim: '', bold: '', off: '' };

/** One sample: bare, then — only if nothing strong showed — each provocation until one does. */
async function evalSample(dir, { run = runContained } = {}) {
  const bare = await run({ dir, canary: CANARY, install: true, timeoutMs: 20000 });
  const first = installVerdict(bare.observed, { decoyStolen: stolenDecoy(bare.observed) });
  const row = { watched: first.watched, ranScript: first.ranScript, scripts: first.scripts, bare: first.strong, strong: first.strong, weak: first.weak,
    credentials: first.credentials, downloader: first.downloader.length > 0, network: first.network.slice(0, 5), decoyStolen: first.decoyStolen,
    provokedBy: null, reasons: first.reasons, timedOut: bare.timedOut };
  if (!first.watched || first.strong || !first.ranScript) return row;

  for (const p of PROVOCATIONS) {
    const r = await run({ dir, provocation: p, canary: CANARY, install: true, timeoutMs: 20000 });
    const v = installVerdict(r.observed, { decoyStolen: stolenDecoy(r.observed) });
    if (v.strong) return { ...row, strong: true, weak: false, provokedBy: p.id, credentials: v.credentials, downloader: v.downloader.length > 0, network: v.network.slice(0, 5), decoyStolen: v.decoyStolen, reasons: v.reasons };
  }
  return row;
}

function metrics(rows) {
  const count = (set, f) => set.filter(f).length;
  const of = (set) => ({
    samples: set.length,
    watched: count(set, (r) => r.watched),
    ranScript: count(set, (r) => r.ranScript),
    strongBare: count(set, (r) => r.bare),
    strong: count(set, (r) => r.strong),
    onlyAfterProvocation: count(set, (r) => r.strong && !r.bare),
    readCredential: count(set, (r) => r.credentials.length > 0),
    downloader: count(set, (r) => r.downloader),
    decoyStolen: count(set, (r) => r.decoyStolen),
    networkOnly: count(set, (r) => r.weak),
    nothingObserved: count(set, (r) => r.watched && !r.strong && !r.weak),
  });
  return { malicious: of(rows.filter((r) => r.label === 'malicious')), benign: of(rows.filter((r) => r.label === 'benign')) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function main() {
  const real = flag('dataset', null);
  if (real && !args.includes('--i-have-a-throwaway-machine')) {
    console.error(`\n  ${C.red}--dataset runs REAL malware.${C.off} Refused here.\n\n  Only on a throwaway machine you can destroy — never a personal one, never Nebius:\n\n    node scripts/install-eval.js --dataset ${real} --i-have-a-throwaway-machine\n`);
    process.exit(3);
  }
  if (!dockerAvailable()) { console.error(`\n  ${C.red}No container runtime.${C.off} Start Docker (or colima) and retry.\n`); process.exit(2); }

  const dir = path.resolve(real || path.join(ROOT, 'proof', 'corpus-install'));
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8')); } catch { /* a real dataset is all malicious */ }
  let names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json'))).map((e) => e.name).sort();
  const limit = Number(flag('limit', 0));
  if (limit > 0) names = names.slice(0, limit);
  const conc = Number(flag('concurrency', 2));

  console.log(`\n  ${C.bold}install-time proof${C.off}  ${C.dim}${names.length} samples · ${real ? 'REAL corpus' : 'synthetic corpus'} · each in --network none${C.off}\n`);
  let done = 0;
  const rows = await pool(names, conc, async (name) => {
    let r;
    try { r = await evalSample(path.join(dir, name)); }
    catch (e) { r = { watched: false, ranScript: false, scripts: [], bare: false, strong: false, weak: false, credentials: [], downloader: false, network: [], decoyStolen: false, provokedBy: null, reasons: [`harness error: ${e.message}`], timedOut: false }; }
    const label = labels[name] || (real ? 'malicious' : 'unlabelled');
    done++;
    const mark = r.strong ? `${C.red}strong ` : r.weak ? `${C.amber}network` : r.watched ? `${C.green}quiet  ` : `${C.dim}unseen `;
    if (!real || done % 10 === 0 || r.strong === false) console.log(`  ${mark}${C.off} ${name.slice(0, 44).padEnd(44)} ${label.padEnd(9)} ${C.dim}${r.reasons.join('; ').slice(0, 90)}${r.provokedBy ? ` — under ${r.provokedBy}` : ''}${C.off}`);
    return { name, label, ...r };
  });

  const m = metrics(rows);
  let base = null;
  try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'install-phase.json'), 'utf8')); } catch { /* printed without it */ }
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(d >= 1000 ? 2 : 0)}%` : '—');
  const line = (label, k) => console.log(`  ${label.padEnd(34)} ${String(m.malicious[k]).padStart(5)} of ${m.malicious.samples}  ${pct(m.malicious[k], m.malicious.samples).padStart(5)}` +
    (m.benign.samples ? `    ${C.dim}benign here ${m.benign[k]} of ${m.benign.samples}${C.off}` : ''));
  console.log(`\n  ${C.bold}malicious samples${C.off}`);
  line('install phase observed', 'watched');
  line('ran an install script', 'ranScript');
  line('STRONG finding', 'strong');
  line('  … on the bare run', 'strongBare');
  line('  … only once provoked', 'onlyAfterProvocation');
  line('read a credential', 'readCredential');
  line('ran a downloader / pipe to shell', 'downloader');
  line('took a planted decoy', 'decoyStolen');
  line('network only (weak, reported apart)', 'networkOnly');
  line('ran, and nothing was observed', 'nothingObserved');
  if (base) {
    console.log(`\n  ${C.bold}the same things on the real registry's most-used packages${C.off}  ${C.dim}docs/install-phase.json, ${base.measured}${C.off}`);
    console.log(`  ran an install script              ${String(base.ranScript).padStart(5)} of ${base.watchedThroughInstall}  ${pct(base.ranScript, base.watchedThroughInstall)}`);
    console.log(`  read something credential-like     ${String(base.readCredentialLike).padStart(5)} of ${base.watchedThroughInstall}  ${pct(base.readCredentialLike, base.watchedThroughInstall)}`);
    console.log(`  reached the network at install     ${String(base.reachedNetwork).padStart(5)} of ${base.watchedThroughInstall}  ${pct(base.reachedNetwork, base.watchedThroughInstall)}`);
  }

  const out = flag('out', path.join(ROOT, 'proof', real ? 'install-eval-real.json' : 'install-eval.json'));
  fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), corpus: real ? `real (${flag('corpus-name', path.basename(dir))})` : 'synthetic (proof/corpus-install)',
    contained: '--network none, read-only root, no capabilities, non-root, sample mounted read-only', ...m,
    registryBaseRates: base ? { measured: base.measured, watchedThroughInstall: base.watchedThroughInstall, ranScript: base.ranScript, readCredentialLike: base.readCredentialLike, reachedNetwork: base.reachedNetwork } : null,
    rows: rows.map(({ name, label, watched, ranScript, scripts, bare, strong, weak, credentials, downloader, network, decoyStolen, provokedBy, reasons }) => ({ name, label, watched, ranScript, scripts, bare, strong, weak, credentials, downloader, network, decoyStolen, provokedBy, reasons })) }, null, 2)}\n`);
  console.log(`\n  ${C.dim}→ ${path.relative(process.cwd(), out)}${C.off}\n`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { evalSample, metrics };
