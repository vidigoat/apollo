#!/usr/bin/env node
/**
 * Draft a report for a caught package — for a person to read, and send, never sent from here.
 *
 *   node scripts/firehose-report.js                       # draft for the top thing the watch moved
 *   node scripts/firehose-report.js --key "pkg@1.0.0→1.0.1"
 *   node scripts/firehose-report.js --demo                # the interrogation catch, as a worked example
 *
 * When the watch finds a release that behaves differently, or the interrogation draws a stealer out,
 * the next step is telling npm — and that message goes out under a person's name, so this only writes
 * a draft to disk (proof/reports/) and prints where. Sending is a human act, done deliberately, to
 * npm's real security contact. Nothing here contacts anyone.
 *
 * The draft is built ENTIRELY from recorded evidence: the versions, the channels that changed, the
 * exact strings observed, the publish signals, the time from publish to verdict. It states what was
 * observed and how, and claims nothing the record does not carry — because a report that overreaches
 * is one npm's security team learns to ignore.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const OUTDIR = path.join(ROOT, 'proof', 'reports');

const readResults = () => {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, 'local', 'firehose', 'results.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip a partial line */ } }
  return out;
};

/** The evidence a change carries, as lines a reader (and npm) can check against the tarballs. */
function evidenceLines(gained) {
  // A default param only fills `undefined`; a record can carry `gained: null` (a differ that found
  // no change), and Object.entries(null) throws. This drafts a report for a person to send, so a
  // missing or malformed diff must produce no evidence lines, never a crash mid-draft.
  if (!gained || typeof gained !== 'object') return [];
  const lines = [];
  for (const [channel, g] of Object.entries(gained)) {
    if (!g || typeof g !== 'object') continue;
    const at = channel.startsWith('install.') ? ' (at install time)' : '';
    const ch = channel.replace(/^install\./, '');
    const show = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
    if (Array.isArray(g.added) && g.added.length) lines.push(`  - ${ch}${at}: now ${g.added.slice(0, 20).map(show).join(', ')}${g.added.length > 20 ? `, and ${g.added.length - 20} more` : ''}`);
    if (Array.isArray(g.removed) && g.removed.length) lines.push(`  - ${ch}${at}: no longer ${g.removed.slice(0, 10).map(show).join(', ')}`);
  }
  return lines;
}

/** A report for one watched-and-moved release. */
function reportForRelease(r) {
  const ev = evidenceLines(r.gained);
  const sigs = (Array.isArray(r.signals) ? r.signals : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => `  - ${s.signal}: ${s.detail}`);
  return `Subject: ${r.pkg}@${r.to} — behaviour changed from ${r.from}, observed in a sandbox

Package: ${r.pkg}
Versions compared: ${r.from} (previous) vs ${r.to} (newest)
${r.weeklyDownloads ? `Weekly downloads: ${r.weeklyDownloads.toLocaleString()}\n` : ''}Observed: ${r.minutesPublishToVerdict != null ? `${r.minutesPublishToVerdict} minutes after ${r.to} was published` : 'shortly after publish'}
Severity (by mechanical rules, not a model): ${r.severity}

What was observed
${r.to} was installed and imported in an isolated microVM, and so was ${r.from} from an identical
starting state. The two behaviours were diffed. ${r.to} did the following that ${r.from} did not:

${ev.length ? ev.join('\n') : '  (no channel-level change recorded)'}
${sigs.length ? `\nSignals from the publish metadata itself:\n${sigs.join('\n')}\n` : ''}
How to reproduce
  git clone https://github.com/vidigoat/apollo && cd cassandra
  node scripts/release-watch.js --rewatch "${r.pkg}@${r.from}→${r.to}"

This is a behavioural difference, observed by running the package, not a judgement of intent. It is
sent so npm's security team can weigh it against the publish record. Every string above is quoted
from the sandbox transcript and can be re-derived by the command above.
`;
}

/** A worked example from the interrogation, when there is no real catch to report yet. */
function demoReport() {
  return `Subject: EXAMPLE — a package that exfiltrates a token only on CI, caught by interrogation

This is a worked example (a synthetic sample authored in this repository, interrogate/sample-stealer),
not a real package. It shows the shape a real report would take.

What was observed
Run in a bare sandbox, the package did nothing observable. Run again under a decoy CI environment with
a planted npm token present, it read the token (env: NPM_TOKEN) and attempted to POST it to an external
host — caught on the wire, and blocked (contained), so nothing left the sandbox.

  - net: attempted connection to exfil.example.com:80
  - net: the planted decoy token was placed in the request body (exfil marker)
  - env: NPM_TOKEN

How to reproduce
  git clone https://github.com/vidigoat/apollo && cd cassandra
  npm run interrogate -- --demo

A real report would name the real package and versions, and carry the same kind of evidence, quoted
from the transcript. Sent to npm only after a person has reviewed it.
`;
}

if (require.main === module) {
  const results = readResults();
  const moved = results.filter((r) => r.outcome === 'watched' && r.severity && r.severity !== 'none')
    .sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));

  let name;
  let body;
  if (args.includes('--demo') || (!flag('key', null) && moved.length === 0)) {
    if (!args.includes('--demo') && moved.length === 0) console.log('  Nothing has been caught in the wild yet — drafting the worked example instead.\n');
    name = 'EXAMPLE-interrogation-catch';
    body = demoReport();
  } else {
    const key = flag('key', null);
    const r = key ? results.find((x) => x.key === key) : moved[0];
    if (!r) { console.error(`\n  No watched result for ${key || 'the top catch'}.\n`); process.exit(2); }
    name = r.key.replace(/[^A-Za-z0-9._@-]/g, '_');
    body = reportForRelease(r);
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const out = path.join(OUTDIR, `${name}.txt`);
  fs.writeFileSync(out, body);
  console.log(`  draft written: ${path.relative(process.cwd(), out)}`);
  console.log('  Review it, then send it yourself to npm security (https://www.npmjs.com/support → report). Nothing was sent.\n');
}

module.exports = { reportForRelease, evidenceLines, demoReport };
