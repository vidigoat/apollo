/**
 * The two things a visitor can do with their own packages, on the hosted URL.
 *
 *   POST /api/lockfile   { lockfile: "<package-lock.json text>" }  or  { repo: "owner/name" }
 *   POST /api/watch      { pkg, from, to }
 *
 * Everything else on the site is the bundled corpus, planted and labelled as planted. These two
 * are not: the first answers a stranger's real tree from the published index, and the second runs a
 * stranger's chosen upgrade — two real versions of a real package — in Nebius Token Factory
 * Sandboxes, right now, and shows what changed.
 *
 * ── /api/lockfile ────────────────────────────────────────────────────────────
 *
 * Runs nothing. It is `stakeout lock` in a browser: every package-version in the tree resolved
 * against `public/index.json`, and the answer split into what is known — with what those packages
 * actually do at install and import — and what nobody has watched, which is reported by name and
 * never as clean.
 *
 * A repository is fetched from raw.githubusercontent.com and nowhere else, by a path built here from
 * a validated owner/name — so the URL is not the caller's to choose, and this cannot be pointed at
 * the inside of anybody's network.
 *
 * ── /api/watch ───────────────────────────────────────────────────────────────
 *
 * If the index already holds both versions, the answer is a lookup and costs nothing. Otherwise both
 * are installed and imported in two microVMs forked from one checkpoint image, and diffed. Bounded
 * before anything runs: both versions must exist on the npm registry, a caller gets a few watches an
 * hour, the whole deployment a few dozen, and a pair has a time limit. The sandboxes run on Nebius,
 * never on this server.
 */

const { parseLockfile } = require('./lockfile');
const { buildLock } = require('./lock');
const { PublishedIndex } = require('./index/published');
const { CHANNELS } = require('./index/schema');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_FILE = path.join(__dirname, 'public', 'index.json');
let published = null;
function index() {
  if (!published) published = new PublishedIndex(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')), { from: 'public/index.json' });
  return published;
}

/** A body, read to a limit — refused in words when it is over, not by hanging up. */
function body(req, limit) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      const b = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? String(req.body) : JSON.stringify(req.body);
      return b.length > limit ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(b);
    }
    let size = 0;
    let over = false;
    const parts = [];
    // Over the limit, the rest is read and dropped, and the refusal is sent once the upload ends —
    // answering mid-upload closes the socket under a client that is still sending, which it
    // reports as a network failure instead of reading the 413.
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; parts.length = 0; return; }
      parts.push(c);
    });
    req.on('end', () => (over ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(parts).toString('utf8'))));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(code === 413 ? { connection: 'close' } : {}) });
  res.end(JSON.stringify(obj));
};

/* ── what a tree does, from the index ──────────────────────────────────────── */

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const MAX_LOCKFILE = 30 * 1024 * 1024;

async function fetchLockfile(repo, fetchImpl = globalThis.fetch) {
  const m = REPO.exec(String(repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, ''));
  if (!m || m[2] === '.' || m[2] === '..') {
    throw Object.assign(new Error('That is not a GitHub repository name. Write it as owner/name.'), { status: 400 });
  }
  const url = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/package-lock.json`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (r.status === 404) {
    throw Object.assign(new Error(`${m[1]}/${m[2]} has no package-lock.json at its root (or is private). pnpm and yarn lockfiles are not read.`), { status: 404 });
  }
  if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status} for ${m[1]}/${m[2]}.`), { status: 502 });
  const declared = Number(r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_LOCKFILE) throw Object.assign(new Error('That lockfile is over 30 MB.'), { status: 413 });
  const text = await r.text();
  if (text.length > MAX_LOCKFILE) throw Object.assign(new Error('That lockfile is over 30 MB.'), { status: 413 });
  return { text, repo: `${m[1]}/${m[2]}` };
}

/** One observed thing, as a person reads it: a host and port, a command, a path, a way code was built. */
const describe = (x) => (typeof x === 'string' ? x
  : x.host ? `${x.host}${x.port ? `:${x.port}` : ''}`
    : Array.isArray(x.argv) ? x.argv.join(' ')
      : x.path ? `${x.op || ''} ${x.path}`.trim()
        : x.how ? String(x.how)
          : JSON.stringify(x));

/** What the known part of a tree does, channel by channel, with the packages that do it. */
function behaviours(lock, cap = 40) {
  const out = {};
  for (const c of CHANNELS) out[c] = { packages: 0, examples: [], byName: {} };
  const nameOf = (c, x) => (c === 'env' || c === 'dns' ? String(x) : c === 'net' ? String(x.host ?? x) : null);
  for (const [id, rec] of Object.entries(lock.packages)) {
    for (const c of CHANNELS) {
      const seen = rec[c];
      if (!Array.isArray(seen) || !seen.length) continue;
      out[c].packages++;
      // "CI, read by 43 packages" is what a person wants from the env channel, not 43 rows.
      for (const x of new Set(seen.map((v) => nameOf(c, v)).filter(Boolean))) out[c].byName[x] = (out[c].byName[x] || 0) + 1;
      if (out[c].examples.length < cap) {
        const what = seen.slice(0, 4).map(describe);
        out[c].examples.push({ package: id, what, more: Math.max(0, seen.length - 4) });
      }
    }
  }
  for (const c of CHANNELS) {
    out[c].byName = Object.fromEntries(Object.entries(out[c].byName).sort((a, b) => b[1] - a[1]).slice(0, 24));
  }
  return out;
}

/*
 * The part worth reading first: known packages that, at install or import, read something that
 * looks like a credential or start a process the differ treats as notable. Named with what they
 * touched. It is not an accusation — plenty of tools read GITHUB_TOKEN on purpose — it is the list a
 * person would want in front of them before anything else.
 */
/*
 * Stricter than the differ's SENSITIVE_ENV on purpose. That one decides whether a CHANGE deserves a
 * look, where a false alarm costs a glance; this one heads a list, and the differ's pattern put
 * GITHUB_ACTIONS, bamboo_planKey and FAKEROOTKEY there — CI detection, not credentials — which is
 * how a list teaches people to skip it. A name that holds a secret, then: tokens, secrets,
 * passwords, private keys, API and access keys.
 */
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|CREDENTIALS?$|_AUTH$|^NPM_CONFIG__?AUTH)/i;

function attention(lock) {
  const { NOTABLE_PROC } = require('./differ/diff');
  const out = [];
  for (const [id, rec] of Object.entries(lock.packages)) {
    const secrets = (rec.env || []).filter((v) => CREDENTIAL.test(String(v)));
    const procs = (rec.proc || []).map(describe).filter((c) => NOTABLE_PROC.test(c));
    if (secrets.length || procs.length) out.push({ package: id, reads: secrets, starts: procs.slice(0, 3) });
  }
  return out.sort((a, b) => b.reads.length + b.starts.length - (a.reads.length + a.starts.length)).slice(0, 30);
}

function answerTree(text, from) {
  let tree;
  try {
    tree = parseLockfile(text);
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: 400 });
  }
  const idx = index();
  const built = buildLock(tree.versions, idx);
  const total = tree.versions.size;
  return {
    from,
    format: tree.format ?? null,
    total,
    known: built.known,
    unknown: built.unknown.length,
    unknownSample: built.unknown.slice(0, 60),
    pct: total ? Math.round((built.known / total) * 100) : 0,
    index: idx.manifest(),
    does: behaviours(built.lock),
    attention: attention(built.lock),
    note: 'Resolved against the published index; nothing was installed or run. Unknown means nobody has watched that version — never that it is clean.',
  };
}

async function lockfile(req, res, { fetchImpl } = {}) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST a lockfile, or { "repo": "owner/name" }.' });
  let raw;
  try {
    raw = await body(req, MAX_LOCKFILE + 4096);
  } catch (e) {
    return json(res, e.status || 400, { error: e.status === 413 ? 'That lockfile is over 30 MB.' : 'Could not read the request.' });
  }
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return json(res, 400, { error: 'Send JSON: { "lockfile": "…" } or { "repo": "owner/name" }.' });
  }
  try {
    if (input && typeof input.repo === 'string' && input.repo.trim()) {
      const { text, repo } = await fetchLockfile(input.repo, fetchImpl);
      return json(res, 200, answerTree(text, repo));
    }
    if (input && typeof input.lockfile === 'string' && input.lockfile.trim()) {
      return json(res, 200, answerTree(input.lockfile, 'your lockfile'));
    }
    return json(res, 400, { error: 'Paste a package-lock.json, or name a GitHub repository as owner/name.' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong reading that tree.' });
  }
}

/* ── one upgrade, watched on Nebius ────────────────────────────────────────── */

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,213}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;
const PER_CALLER = { n: 4, windowMs: 60 * 60 * 1000 };
const PER_DEPLOYMENT = { n: 40, windowMs: 60 * 60 * 1000 };
const calls = new Map(); // caller → timestamps
let all = [];
const results = new Map(); // "pkg@from→to" → answer, for the life of the instance
let shared = null; // { adapter, checkpoint } — see watch()

function limited(caller, now = Date.now()) {
  all = all.filter((t) => now - t < PER_DEPLOYMENT.windowMs);
  const mine = (calls.get(caller) || []).filter((t) => now - t < PER_CALLER.windowMs);
  if (mine.length >= PER_CALLER.n) return `You have watched ${PER_CALLER.n} upgrades in the last hour — the limit, so the sandboxes stay available to everybody.`;
  if (all.length >= PER_DEPLOYMENT.n) return 'This demo has run its hourly share of sandboxes. Try again later, or run it yourself: npm run real -- --nebius <pkg> <from> <to>.';
  mine.push(now); all.push(now); calls.set(caller, mine);
  return null;
}

async function onRegistry(pkg, versions, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return { ok: false, why: `${pkg} is not on the npm registry.` };
  if (!r.ok) return { ok: false, why: `The npm registry answered ${r.status}.` };
  const doc = await r.json();
  const missing = versions.filter((v) => !doc.versions?.[v]);
  return missing.length ? { ok: false, why: `${pkg} has no published version ${missing.join(' or ')}.` } : { ok: true };
}

const channelsOf = (entry) => Object.fromEntries(CHANNELS.map((c) => [c, entry?.[c]]));

async function watch(req, res, deps = {}) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST { pkg, from, to }.' });
  let input;
  try {
    input = JSON.parse((await body(req, 4096)) || '{}');
  } catch (e) {
    return json(res, e.status || 400, { error: e.status === 413 ? 'Too long.' : 'Send JSON: { "pkg": "…", "from": "1.2.0", "to": "1.3.0" }.' });
  }
  const pkg = String(input?.pkg || '').trim().toLowerCase();
  const from = String(input?.from || '').trim();
  const to = String(input?.to || '').trim();
  if (!NAME.test(pkg)) return json(res, 400, { error: 'That is not an npm package name.' });
  if (!VERSION.test(from) || !VERSION.test(to)) return json(res, 400, { error: 'Versions are exact releases, like 4.17.20 → 4.17.21.' });
  if (from === to) return json(res, 400, { error: 'Pick two different versions — the point is what changed between them.' });

  const key = `${pkg}@${from}→${to}`;
  const { diff, summarise } = require('./differ/diff');

  // Already watched — by the index build, or by an earlier visitor on this instance. Free.
  const idx = index();
  const a = idx.lookup(pkg, from);
  const b = idx.lookup(pkg, to);
  if (a && b) {
    const t = (e, version) => ({ ...channelsOf(e), pkg, version, strategy: e.strategy, canSee: e.canSee, timing: {} });
    const d = diff(t(a, from), t(b, to));
    return json(res, 200, { key, pkg, versions: [from, to], from: 'the published index — watched already, nothing run now', before: channelsOf(a), after: channelsOf(b), severity: d.severity, summary: summarise(d), reasons: d.reasons || [] });
  }
  if (results.has(key)) return json(res, 200, results.get(key));

  if (!deps.adapter && !(process.env.NEBIUS_API_KEY && process.env.NEBIUS_PROJECT_ID)) {
    return json(res, 503, { error: 'Live watching needs Nebius Sandboxes credentials on this deployment, and it has none. Run it yourself: npm run real -- --nebius <pkg> <from> <to>.' });
  }

  const caller = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'someone').split(',')[0].trim();
  const stop = deps.skipLimits ? null : limited(caller);
  if (stop) return json(res, 429, { error: stop });

  let reg;
  try {
    reg = await (deps.registry || onRegistry)(pkg, [from, to]);
  } catch {
    return json(res, 502, { error: 'The npm registry could not be reached, so nothing was run.' });
  }
  if (!reg.ok) return json(res, 404, { error: reg.why });

  const started = Date.now();
  try {
    const { runPair } = require('./runPair');
    const { bestStrategy } = require('./observe');
    let adapter = deps.adapter;
    let checkpoint;
    if (adapter) {
      checkpoint = await adapter.boot();
    } else {
      /*
       * One checkpoint per server instance, not per request. Importing Node and setting it up was
       * about forty of a first watch's sixty-five seconds, and it is identical every time — the
       * checkpoint is an image on Nebius, and every pair forks from it. A pair that fails against
       * a cached checkpoint drops it, so the next request boots a fresh one.
       */
      if (!shared) {
        const { ConTreeSandboxes } = require('./adapters/contree');
        const a = new ConTreeSandboxes({ image: 'docker.io/library/node:22-slim' });
        shared = { adapter: a, checkpoint: a.boot() };
      }
      adapter = shared.adapter;
      try {
        checkpoint = await shared.checkpoint;
      } catch (e) {
        shared = null;
        throw e;
      }
    }
    const strategy = bestStrategy(adapter);
    let pair;
    try {
      pair = await runPair({ adapter, checkpoint, pkg, from, to, strategy });
    } catch (e) {
      if (!deps.adapter) shared = null;
      throw e;
    }
    const { before, after, diff: d } = pair;
    const answer = {
      key,
      pkg,
      versions: [from, to],
      from: 'watched just now, in two Nebius Token Factory Sandboxes forked from one checkpoint image',
      seconds: Math.round((Date.now() - started) / 1000),
      strategy,
      before: channelsOf(before),
      after: channelsOf(after),
      severity: d.severity,
      summary: summarise(d),
      reasons: d.reasons || [],
    };
    results.set(key, answer);
    return json(res, 200, answer);
  } catch (e) {
    return json(res, 502, { error: `The sandboxes could not finish that pair: ${String(e.message).split('\n')[0].slice(0, 160)}` });
  }
}

/*
 * Neither handler can take the server down. They are async, and a throw that escaped one was an
 * unhandled rejection — which in Node ends the process, for every visitor, on one bad request.
 */
const guarded = (fn) => (req, res, deps) => Promise.resolve().then(() => fn(req, res, deps)).catch(() => {
  if (!res.headersSent) json(res, 500, { error: 'Something went wrong on our side. Nothing was run.' });
});

module.exports = { lockfile: guarded(lockfile), watch: guarded(watch), answerTree, fetchLockfile, behaviours, attentionFor: attention, limited, describe, NAME, VERSION };
