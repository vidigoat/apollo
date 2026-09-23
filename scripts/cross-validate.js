#!/usr/bin/env node
/**
 * Does an observation depend on the machine that made it? Measured.
 *
 *   node scripts/cross-validate.js --fleet <fleet.json> --limit 300     # re-observe on Nebius, compare
 *   node scripts/cross-validate.js --local 300                           # re-observe entries made locally
 *   node scripts/cross-validate.js --dir <index-dir>                     # compare an index already built
 *
 * The whole argument of a central index is that a package's behaviour is a property of the
 * package — so an observation made anywhere answers for everyone. That is a claim about
 * reproducibility, and it is checkable: take the most-shared packages the index already holds,
 * observe them again somewhere else entirely — in Nebius Token Factory Sandboxes, microVMs that share
 * nothing with the machine that built the index — and compare every channel of every transcript.
 *
 * Identical means identical on every channel the strategy can see: net, dns, fs, env, proc, exec.
 * The run records itself in docs/crossval.json so the documents can quote it and be held to it.
 */

require('../env').loadEnv();

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Index, CHANNELS } = require('../index/schema');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : null; };

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []));

function compare(dir, against = new Index()) {
  const out = { compared: 0, identical: 0, differing: 0, notInIndex: 0, byChannel: {}, observedOn: {}, pairs: {}, examples: [] };
  for (const f of walk(path.join(dir, 'entries'))) {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [v, e] of Object.entries(r.versions || {})) {
      const l = against.lookup(r.name, v);
      if (!l) { out.notInIndex++; continue; }
      out.compared++;
      if (e.observedOn) out.observedOn[e.observedOn] = (out.observedOn[e.observedOn] || 0) + 1;
      const bad = CHANNELS.filter((c) => JSON.stringify(e[c] ?? null) !== JSON.stringify(l[c] ?? null));
      // Where each side was made, so a match between two runs on the same machine is never
      // reported as agreement between two machines.
      const pair = `${l.observedOn || 'local'} vs ${e.observedOn || 'local'}`;
      out.pairs[pair] = out.pairs[pair] || { identical: 0, differing: 0 };
      out.pairs[pair][bad.length ? 'differing' : 'identical']++;
      if (!bad.length) { out.identical++; continue; }
      out.differing++;
      for (const c of bad) out.byChannel[c] = (out.byChannel[c] || 0) + 1;
      if (out.examples.length < 10) out.examples.push({ pkg: `${r.name}@${v}`, channels: bad });
    }
  }
  return out;
}

module.exports = { compare };

if (require.main === module) {
  let dir = flag('dir');
  const limit = Number(flag('limit')) || 300;
  if (!dir) {
    const fleet = flag('fleet');
    const local = flag('local');
    if (!fleet && !local) { console.error('usage: --fleet <fleet.json> [--limit N]  or  --local N  or  --dir <index-dir>'); process.exit(3); }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossval-'));
    const from = fleet ? ['--from-fleet', fleet, '--limit', String(limit)]
      : ['--from-index', path.join(ROOT, 'index', 'data'), '--observed-on', 'local', '--limit', String(Number(local) || 300)];
    execFileSync(process.execPath, [path.join(__dirname, 'index-build.js'), '--nebius', ...from,
      '--concurrency', '30', '--out', dir], { stdio: 'inherit' });
  }
  const r = compare(dir);
  const record = { measured: new Date().toISOString().slice(0, 10), strategy: 'nodert', ...r };
  fs.writeFileSync(path.join(ROOT, 'docs', 'crossval.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n  ${r.identical} of ${r.compared} transcripts identical on every channel` +
    `${r.differing ? ` · ${r.differing} differ (${Object.entries(r.byChannel).map(([c, n]) => `${c} ${n}`).join(', ')})` : ''}` +
    ` · observed on ${Object.keys(r.observedOn).join(', ') || 'unrecorded'}` +
    `${Object.entries(r.pairs).map(([k, v]) => `\n    ${k}: ${v.identical} identical, ${v.differing} differ`).join('')}` +
    `\n  recorded in docs/crossval.json\n`);
  process.exitCode = r.differing ? 1 : 0;
}
