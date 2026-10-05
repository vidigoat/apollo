#!/usr/bin/env node
/**
 * What the GitHub App posts, without a GitHub App.
 *
 *   npm run check-run
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The App is built, tested and deployed — the webhook answers on the demo URL — and it is not
 * registered, because GitHub has no REST endpoint for creating one. That is a button a person
 * presses, and it is the only thing in this project that cannot be done from a terminal.
 *
 * Which leaves a reviewer with a claim and no way to check it. So this drives the real handler,
 * with the real signature verification, over a delivery shaped exactly like GitHub's, and prints
 * the check run that comes out the other end. Nothing is stubbed except the four calls that would
 * touch github.com, and those are injected by the same `wired` parameter the tests use.
 *
 * Three pull requests, and the middle one is the argument:
 *
 *   drift     a version that did not move, behaving differently          failure
 *   unknown   packages the index has never observed                      NEUTRAL, never failure
 *   clean     every package observed, none of them drifted               success
 *
 * On any real tree most packages start unknown. A check that goes red on the day it is installed
 * is switched off in week one — and then the day it has something real to say, nobody is listening.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle } = require('../github/handle');
const { Index } = require('../index/schema');
const { buildLock } = require('../lock');
const { parseLockfile } = require('../lockfile');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', amber: '', green: '', bold: '', off: '' };

const rule = () => console.log(`${C.dim}${'─'.repeat(78)}${C.off}`);

const SECRET = 'a-secret-only-this-script-and-this-process-know';
const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;

/** A transcript, in the shape the index stores. */
const observed = (version, over = {}) => ({
  pkg: 'p',
  version,
  strategy: 'nodert',
  canSee: { net: true, dns: true, fs: 'writes', env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  ...over,
});

const lockfileText = (deps) =>
  JSON.stringify({
    name: 'someones-app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'someones-app' },
      ...Object.fromEntries(deps.map(([n, v]) => [`node_modules/${n}`, { name: n, version: v }])),
    },
  });

/** A pull_request delivery, as GitHub sends it. */
const delivery = () =>
  JSON.stringify({
    action: 'synchronize',
    installation: { id: 42 },
    repository: { name: 'app', owner: { login: 'someone' } },
    pull_request: { number: 108, draft: false, head: { sha: 'c0ffee1234567890' }, base: { sha: 'ba5e000000000000' } },
  });

async function post({ title, note, deps, drifted = null, indexHas, was = null, ledger = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-run-'));
  const index = new Index({ dir });
  for (const [name, version] of indexHas) index.put(name, observed(version));
  index.writeManifest({ revision: 'demo' });

  const text = lockfileText(deps);
  const { lock } = buildLock(parseLockfile(text).versions, index);

  // The drift: the same version, observed doing something it did not do before. This is the whole
  // product — nothing in the lockfile changed, and the check fails anyway.
  if (drifted) index.put(drifted[0], observed(drifted[1], drifted[2]));

  let posted = null;
  const raw = delivery();

  const out = await handle(
    { raw, signature: sign(raw), event: 'pull_request' },
    { secret: SECRET, index, ledger },
    {
      installationToken: async () => 'a-token-scoped-to-one-installation',
      filesIn: async () => ['package-lock.json', 'src/index.js'],
      // The base commit holds the lockfile as it was before the pull request, when one is given.
      fileAt: async ({ path: p, ref }) =>
        p.endsWith('apollo.lock') ? JSON.stringify(lock) : (was && ref === 'ba5e000000000000' ? lockfileText(was) : text),
      postCheck: async ({ run }) => {
        posted = run;
        return { id: 1 };
      },
    }
  );

  fs.rmSync(dir, { recursive: true, force: true });

  const tone = { failure: C.red, neutral: C.amber, success: C.green }[posted?.conclusion] || '';
  rule();
  console.log(`${C.bold}${title}${C.off}  ${C.dim}${note}${C.off}\n`);
  console.log(`  ${C.dim}POST /repos/someone/app/check-runs  → ${out.status}${C.off}`);
  console.log(`  ${C.dim}name${C.off}        apollo`);
  console.log(`  ${C.dim}conclusion${C.off}  ${tone}${posted.conclusion}${C.off}`);
  console.log(`  ${C.dim}title${C.off}       ${posted.title}\n`);
  for (const line of posted.summary.split('\n')) console.log(`  ${C.dim}│${C.off} ${line}`);
  console.log();
}

(async () => {
  rule();
  console.log(`${C.bold}THE GITHUB APP${C.off}  what it posts on a pull request, driven through the real handler`);
  console.log(`${C.dim}Signature verified against the raw bytes. Only the four calls that would reach`);
  console.log(`github.com are injected — see scripts/check-run.js.${C.off}`);

  await post({
    title: 'A patch release that behaves differently',
    note: 'the version did not move',
    deps: [['left-pad', '1.3.0'], ['ms', '2.1.3']],
    indexHas: [['left-pad', '1.3.0'], ['ms', '2.1.3']],
    drifted: ['left-pad', '1.3.0', { env: ['AWS_SECRET_ACCESS_KEY'], net: [{ host: 'cdn-assets-delivery.workers.dev', port: 443 }] }],
  });

  /*
   * The dependency bot's pull request, against the REAL record: public/watched-releases.json is
   * every release pair the live watcher has run on Nebius, and source-map-js 1.2.1 → 1.2.2 is one
   * it flagged the day it was published. Nothing here is planted; if the watcher's record changes,
   * so does this output.
   */
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'watched-releases.json'), 'utf8')); } catch { /* shown without it */ }
  const real = ledger?.pairs?.['source-map-js']?.['1.2.1→1.2.2'];
  if (real) {
    await post({
      title: 'A dependency bot bumps a package',
      note: `a real release, from the live watch — ${ledger.count} pairs on record`,
      was: [['source-map-js', '1.2.1'], ['ms', '2.1.3']],
      deps: [['source-map-js', '1.2.2'], ['ms', '2.1.3']],
      indexHas: [['ms', '2.1.3']],
      ledger,
    });
  }

  await post({
    title: 'A tree the index has never seen',
    note: 'the normal state of a dependency tree',
    deps: [['left-pad', '1.3.0'], ['ghost', '9.9.9'], ['spectre', '0.0.1']],
    indexHas: [['left-pad', '1.3.0']],
  });

  await post({
    title: 'Everything observed, nothing changed',
    note: 'the only run that earns the word "passed"',
    deps: [['left-pad', '1.3.0'], ['ms', '2.1.3']],
    indexHas: [['left-pad', '1.3.0'], ['ms', '2.1.3']],
  });

  rule();
  console.log(
    `${C.dim}The middle one is the point: unknown is ${C.off}neutral${C.dim}, never a failure. A check that\n` +
      `red-lights on the day it is installed is switched off before it ever finds anything.${C.off}`
  );
  rule();
})();
