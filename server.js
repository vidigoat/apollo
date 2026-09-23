/* STAKEOUT — zero-dependency dev server. node server.js -> http://localhost:8791 */
const http = require('http');
require('./env').loadEnv();
const { sandboxCost } = require('./pricing');
const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');

const { SimulatedSandboxes } = require('./adapters/simulated');
const { runAll, runPair } = require('./runPair');
const { judgeRun } = require('./judge');
const { lookUp } = require('./evidence/tavily');
const { observePackage, bestStrategy } = require('./observe');
const { diff } = require('./differ/diff');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('./corpus');
const { STRATEGIES } = require('./transcript/schema');

const PORT = Number(process.env.PORT) || 8791;

/**
 * Where the site is served from.
 *
 * `dist/` is the built site — React, and one orchestrated moment on the first screen. `public/`
 * holds what both the site and the API read, `fleet-demo.json` above all, and is the fallback when
 * nothing has been built yet.
 *
 * Resolved from this file, so it is correct whether started with `npm start` from the repository
 * root or imported by a host that runs from somewhere else entirely.
 *
 * The site has its own dependencies and its own package.json, in `web/`. `stakeout` itself still
 * has none and still needs no build step — that is a claim this project makes in its README, and a
 * website is not a reason to stop keeping it.
 */
const DIST = path.join(__dirname, 'dist');
const PUBLIC = path.join(__dirname, 'public');
const ROOTS = fs.existsSync(DIST) ? [DIST, PUBLIC] : [PUBLIC];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const send = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

/**
 * What the open web says about a finding.
 *
 * Live, this is a Tavily search. Without a TAVILY_API_KEY it answers from the recorded corpus
 * instead, and labels every answer `simulated: true` so a stand-in can never be mistaken for a
 * finding. Same shape either way — see evidence/tavily.js.
 */
const publicRecordFor = (pkg, version) => lookUp(pkg, version, { recorded: PUBLIC_RECORD });

/**
 * Packages for the live run. Ordinary, popular, ones we already trust — and chosen so the three
 * outcomes are all visible: one that does nothing observable, one that genuinely reads an
 * environment variable at BOTH versions and is correctly reported as unchanged, and one that
 * actually changed. The middle case is the one that shows we are watching rather than guessing.
 */
const REAL_JOBS = require('./scripts/survey-pairs').PAIRS;

const realAllowed = () => process.env.STAKEOUT_ALLOW_LOCAL === '1';

/**
 * The same pipeline, against the real registry, on this machine.
 *
 * Deliberately gated: these packages execute as whoever started the server, with its network and
 * its files. Nothing isolates them. See adapters/local.js.
 */
async function realRun() {
  const { LocalMachines } = require('./adapters/local');
  const { BehaviourCache } = require('./cache');
  const machines = new LocalMachines({ timeoutMs: 120_000 });
  // The same cache the CLI uses. The first live run is slow; every one after it is not, which is
  // what makes twenty real packages a thing you can put behind a button at all.
  const cache = new BehaviourCache();
  const strategy = bestStrategy(machines);
  const checkpoint = await machines.boot();
  const pairs = [];
  const started = Date.now();

  try {
    for (const [pkg, from, to] of REAL_JOBS) {
      try {
        const job = { pkg, from, to, strategy };
        const known = cache.get(job);
        // runPair when there is anything to run: it is where "both twins from one checkpoint" and
        // "every branch released" are guaranteed, and reimplementing the sequence here would put
        // the shipping path outside the test that proves them.
        const ran = known ? null : await runPair({ adapter: machines, checkpoint, pkg, from, to, strategy });
        const before = ran?.before ?? null;
        const after = ran?.after ?? null;
        const d = known || ran.diff;
        if (!known) cache.put(job, d);
        pairs.push({
          pkg, from, to, diff: d,
          // A cached answer has the diff and not the two transcripts it came from. The wall reads
          // the diff; the columns need the transcripts, so a cached row says so rather than
          // rendering two empty panels that would read as "nothing happened".
          before, after, fromCache: Boolean(known),
          record: d.changed ? await publicRecordFor(pkg, to) : null,
          invariant: null,
        });
      } catch (e) {
        // A package that will not install here is a fact about that package, not the end of a run.
        pairs.push({ pkg, from, to, failed: true, reason: String(e.message).slice(0, 160) });
      }
    }

    // A package that would not install is a fact about that package, not part of the wall. Counted
    // separately and never folded into "behaved identically", which would be a lie by omission.
    const runnable = pairs.filter((p) => !p.failed);
    const judged = await judgeRun(runnable);
    runnable.forEach((p, i) => { p.judgement = judged.results[i]; });

    return {
      live: true,
      failed: pairs.filter((p) => p.failed).length,
      tree: { total: REAL_JOBS.length, moved: REAL_JOBS.length },
      strategy,
      canSee: runnable[0]?.diff.canSee ?? null,
      twinsForked: runnable.length * 2,
      quiet: runnable.filter((p) => !p.diff.changed).length,
      wallMs: Date.now() - started,
      sandboxUsd: 0,
      modelUsd: judged.costUsd,
      modelCalls: judged.modelCalls,
      accused: judged.accused,
      simulatedJudgement: judged.simulated,
      costUsd: judged.costUsd,
      pairs: runnable,
    };
  } finally {
    machines.cleanup();
  }
}

/**
 * One request handler, exported.
 *
 * Nebius asks for a working demo URL, and the fixture run needs nothing a host would refuse: no
 * child processes, no writes, no network. So the same function serves `npm start` locally and a
 * serverless deployment, rather than there being a second, subtly different copy for hosting —
 * which is how a demo URL ends up showing something the repository does not do.
 *
 * The live-registry route stays off in both unless STAKEOUT_ALLOW_LOCAL is set, and says so. A
 * hosted deployment must not run strangers' packages on someone else's machine.
 */
function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    /*
     * The GitHub App's front door.
     *
     * Anybody on the internet can POST here, so this route is the one place in the server that
     * reads its body as bytes and checks a signature before it believes a word of it. See
     * github/webhook.js — the verification and the verdict live there, away from anything that
     * touches the network, so what this says about somebody's pull request can be tested offline.
     */
    if (url.pathname === '/api/github/webhook') {
      if (req.method !== 'POST') return send(res, 405, 'post only', 'text/plain');
      return githubWebhook(req, res);
    }

    /*
     * The two things a visitor can do with their OWN packages: resolve a lockfile against the
     * published index (runs nothing), and watch one upgrade in Nebius Sandboxes. See yours.js.
     */
    if (url.pathname === '/api/lockfile') return require('./yours').lockfile(req, res);
    if (url.pathname === '/api/watch') return require('./yours').watch(req, res);

    if (url.pathname === '/api/tree') {
      return send(
        res,
        200,
        JSON.stringify({
          total: TOTAL,
          moved: CHANGED.length,
          unchanged: TOTAL - CHANGED.length,
          realAllowed: realAllowed(),
          strategies: STRATEGIES,
          realJobs: REAL_JOBS.map(([pkg, from, to]) => ({ pkg, from, to })),
          packages: CHANGED.map(({ pkg, from, to }) => ({ pkg, from, to })),
        }),
        'application/json'
      );
    }

    /* A real run: fork the same checkpoint twice per package, install and import both, diff. */
    if (url.pathname === '/api/run') {
      const adapter = new SimulatedSandboxes();

      /*
       * ?strategy= lets the page read the same corpus four ways.
       *
       * An unrecognised one used to fall through to whatever the adapter defaults to, which is
       * `ebpf` — the STRONGEST strategy, and the one that has never actually run. So
       * `?strategy=typo` came back stamped `"strategy": "ebpf"`, and every claim in that response
       * carried a watcher that had not watched it. A silent fallback to the weakest thing would be
       * a smaller version of the same bug; the only honest answer to a name nobody defines is to
       * say so.
       */
      const asked = url.searchParams.get('strategy');
      if (asked !== null && !STRATEGIES.includes(asked)) {
        return send(res, 400, JSON.stringify({
          error: `No strategy called ${JSON.stringify(asked).slice(0, 60)}.`,
          strategies: STRATEGIES,
          why: 'Every claim in a run carries the strategy that made it, so a run cannot be labelled '
            + 'with one that does not exist — and guessing which you meant would label it with one '
            + 'you did not ask for.',
        }), 'application/json');
      }
      const want = asked ?? undefined;
      return runAll({ adapter, changed: CHANGED, strategy: want })
        .then(async (r) => {
          const pairs = r.results.map((p) => ({
            pkg: p.pkg,
            from: p.from,
            to: p.to,
            diff: p.diff,
            before: p.before,
            after: p.after,
            record: null, // filled in below; a lookup is a network call
            invariant: INVARIANT_FAILURES[`${p.pkg}@${p.to}`] || null,
          }));

          // The public record, but only for packages that actually did something different.
          // Searching for 1,200 versions that behaved identically would be a bill for nothing.
          await Promise.all(pairs.map(async (p) => {
            if (p.diff.changed) p.record = await publicRecordFor(p.pkg, p.to);
          }));

          // Nemotron reads the diffs — never the packages. Quiet ones never reach a model at all.
          const judged = await judgeRun(pairs);
          pairs.forEach((p, i) => { p.judgement = judged.results[i]; });

          return send(
            res,
            200,
            JSON.stringify({
              live: false, // a fixture, so the demo is deterministic; /api/real is the live one
              tree: { total: TOTAL, moved: CHANGED.length },
              checkpoint: r.checkpoint,
              strategy: r.strategy,
              canSee: pairs[0]?.diff.canSee ?? null,
              twinsForked: r.twinsForked,
              quiet: r.quiet,
              wallMs: r.wallMs,
              sandboxUsd: sandboxCost(r.twinsForked).usd,
              sandboxUsdEstimated: sandboxCost(r.twinsForked).estimated,
              sandboxUsdLabel: sandboxCost(r.twinsForked).label,
              modelUsd: judged.costUsd,
              modelCalls: judged.modelCalls,
              accused: judged.accused,
              simulatedJudgement: judged.simulated,
              costUsd: Number((sandboxCost(r.twinsForked).usd + judged.costUsd).toFixed(2)),
              pairs,
            }),
            'application/json'
          );
        })
        .catch((e) => send(res, 500, JSON.stringify({ error: e.message }), 'application/json'));
    }

    /* The same pipeline, live, against the real registry. Slow on purpose: it is really running. */
    if (url.pathname === '/api/real') {
      if (!realAllowed()) {
        return send(res, 403, JSON.stringify({
          error: 'Live runs are off. Start the server with STAKEOUT_ALLOW_LOCAL=1 — and read ' +
                 'adapters/local.js first: these packages run as you, with your network and your files.',
        }), 'application/json');
      }
      return realRun()
        .then((r) => send(res, 200, JSON.stringify(r), 'application/json'))
        .catch((e) => send(res, 500, JSON.stringify({ error: e.message }), 'application/json'));
    }

    /*
     * The fleet: every project on this machine, and how much of each one anyone has watched.
     *
     * Read from disk rather than scanned on request — a scan walks a directory tree and belongs
     * behind a command somebody typed, not behind a page load. There is deliberately no bundled
     * sample: a canned fleet would be a fabricated number, and the honest empty state ("run the
     * scan") is the same answer the CLI gives for a missing index.
     */
    /*
     * ── What the published index holds ───────────────────────────────────────
     *
     * The header of `public/index.json`, without the six hundred kilobytes underneath it.
     *
     * The page needs four numbers to make an honest offer — how many packages somebody would get by
     * pointing `--index` at this URL, and how big the download is. Fetching the whole artefact to
     * read its first five fields would make the page slower for no reason, and typing the numbers
     * into the page would put them one publish away from being wrong.
     */
    if (url.pathname === '/api/index') {
      const file = path.join(PUBLIC, 'index.json');
      if (!fs.existsSync(file)) {
        return send(res, 200, JSON.stringify({
          published: false,
          how: 'npm run index:publish',
          why: 'No index has been published from this checkout, so there is nothing to offer.',
        }), 'application/json');
      }
      const raw = fs.readFileSync(file, 'utf8');
      const doc = JSON.parse(raw);
      return send(res, 200, JSON.stringify({
        published: true,
        url: '/index.json',
        revision: doc.revision,
        generatedAt: doc.generatedAt,
        strategies: doc.strategies,
        canSee: doc.canSee,
        counts: doc.counts,
        bytes: Buffer.byteLength(raw),
        gzipBytes: zlib.gzipSync(raw).length,
      }), 'application/json');
    }

    if (url.pathname === '/api/fleet') {
      /*
       * Your machine first; a public monorepo as the fallback.
       *
       * The committed demo is a real scan of a real checkout of vercel/turborepo — 24 projects,
       * every count measured, reproducible by anyone who clones it and runs the same command. It
       * exists because the hosted demo has no filesystem, and a judge opening the URL to an empty
       * page learns nothing.
       *
       * It is NOT presented as the reader's own fleet. `demo: true` travels with it and the page
       * says whose tree it is, because the interesting thing about a fleet view is that it is
       * yours, and quietly substituting somebody else's would be the exact overclaim this project
       * spends its test suite preventing.
       */
      const file = path.join(__dirname, 'local', 'fleet.json');
      const demo = path.join(PUBLIC, 'fleet-demo.json');
      const using = fs.existsSync(file) ? file : fs.existsSync(demo) ? demo : null;

      if (!using) {
        return send(res, 200, JSON.stringify({
          scanned: false,
          how: 'node scripts/fleet-scan.js ~ --out local/fleet.json',
          why: 'Nothing here is bundled. This reads your machine or it reads nothing.',
        }), 'application/json');
      }
      try {
        const fleet = JSON.parse(fs.readFileSync(using, 'utf8'));
        /*
         * The index size comes from the SCAN, not from the manifest on disk right now. Both halves
         * of the reuse ratio have to be from the same instant — see scripts/fleet-scan.js. What is
         * read live is only whether the index has moved since, which the page reports as a reason
         * to re-scan rather than quietly folding into the arithmetic.
         */
        let now = null;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'index', 'data', 'manifest.json'), 'utf8'));
          now = { packages: m.packages, versions: m.versions, revision: m.revision };
        } catch { /* no index on disk */ }
        const stale = Boolean(now && fleet.index && now.versions !== fleet.index.versions);
        return send(res, 200, JSON.stringify({
          scanned: true, demo: using === demo, indexNow: now, stale, ...fleet,
        }), 'application/json');
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: `${path.basename(using)} is unreadable: ${e.message}` }), 'application/json');
      }
    }

    /*
     * One project's dependencies, and what the index knows about each.
     *
     * Addressed by its position in the scan, never by a path off the query string. A `?dir=` that
     * the server happily reads is a directory-traversal hole with a nice name, and the scan already
     * says which directories are in play — so that list is the allowlist, and anything not in it is
     * simply not a project this server knows about.
     */
    if (url.pathname === '/api/project') {
      const local = path.join(__dirname, 'local', 'fleet.json');
      const bundled = path.join(PUBLIC, 'fleet-demo.json');
      const from = fs.existsSync(local) ? local : bundled;
      if (!fs.existsSync(from)) return send(res, 404, JSON.stringify({ error: 'no scan on disk' }), 'application/json');

      const fleet = JSON.parse(fs.readFileSync(from, 'utf8'));
      const at = Number(url.searchParams.get('at'));
      const repo = Number.isInteger(at) ? fleet.repos[at] : null;
      if (!repo || !repo.dir) {
        return send(res, 404, JSON.stringify({ error: 'no such project in the scan' }), 'application/json');
      }

      /*
       * Project directories are stored relative to the scan's root, so a scan can be committed
       * without writing somebody's home directory into it. That means a scan taken on another
       * machine has counts but nothing to drill into, and saying so is the right answer.
       */
      const root = fleet.root && fleet.root !== '(withheld)' ? fleet.root : null;
      const dir = root ? path.resolve(root, repo.dir) : repo.dir;
      if (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
        return send(res, 404, JSON.stringify({
          error: `This scan was taken somewhere else — ${repo.name}'s lockfile is not on this machine. ` +
                 'Its counts are real; there is nothing here to open.',
        }), 'application/json');
      }

      try {
        const { Index } = require('./index/schema');
        const { quietness } = require('./transcript/schema');
        const { parseLockfile } = require('./lockfile');
        const index = new Index();

        const { versions } = parseLockfile(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
        const deps = [];
        for (const [name, version] of versions) {
          const entry = index.lookup(name, version);
          if (!entry) {
            // Never observed. Not "it does nothing" — see index/schema.js.
            deps.push({ name, version, observed: false });
            continue;
          }
          const q = quietness({
            strategy: entry.strategy,
            net: entry.net || [], dns: entry.dns || [], fs: entry.fs || [],
            env: entry.env || [], proc: entry.proc || [], exec: entry.exec || [],
          });
          deps.push({
            name, version, observed: true,
            strategy: entry.strategy,
            canSee: entry.canSee,
            counts: Object.fromEntries(
              ['net', 'dns', 'fs', 'env', 'proc', 'exec'].map((c) => [c, entry[c] ? entry[c].length : null])
            ),
            quiet: q.quiet,
            blindTo: q.blindTo,
            trustworthy: q.trustworthy,
          });
        }

        return send(res, 200, JSON.stringify({
          name: repo.name, deps: deps.length, state: repo.state, packages: deps,
        }), 'application/json');
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));

    /*
     * Each root is tried in turn, and a path that climbs out of the one it was resolved against is
     * refused rather than tried against the next — `../server.js` must not become a miss that
     * falls through to somewhere it does happen to exist.
     */
    const tryRoot = (i) => {
      if (i >= ROOTS.length) return send(res, 404, 'not found', 'text/plain');
      const root = ROOTS[i];
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) return send(res, 403, 'no', 'text/plain');
      fs.readFile(file, (err, buf) => {
        if (err) return tryRoot(i + 1);
        send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
      });
    };
    tryRoot(0);
}

/**
 * The body as GitHub sent it.
 *
 * Bytes, not an object. An HMAC is over the exact bytes signed, and a parsed body re-serialised
 * comes back with different whitespace and key order — the signature then fails for a delivery
 * that was perfectly genuine, which is a whole afternoon if you have not met it before.
 *
 * Some hosts read the body before the handler sees it. If the stream is already spent we take what
 * they kept, and refuse rather than re-serialise if all that survived was an object.
 */
function rawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.readableEnded || req.readableAborted) {
      const kept = req.rawBody ?? req.body;
      if (Buffer.isBuffer(kept) || typeof kept === 'string') return resolve(Buffer.from(kept));
      return reject(new Error('the body was consumed before it could be verified'));
    }

    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // A signature check on an unbounded body is a way to be knocked over by one request.
      if (size > limit) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/**
 * The private key as an environment variable.
 *
 * A PEM is multi-line and most places that hold secrets are not, so the newlines usually arrive
 * escaped. Accepting both spellings costs one line and saves an error that reads like a corrupt
 * key rather than a formatting one.
 */
const pem = (s) => (s || '').includes('\\n') ? s.replace(/\\n/g, '\n') : s;

async function githubWebhook(req, res) {
  let raw;
  try {
    raw = await rawBody(req);
  } catch (e) {
    return send(res, 400, JSON.stringify({ ok: false, reason: e.message }), 'application/json');
  }

  const { handle } = require('./github/handle');
  const { Index } = require('./index/schema');

  try {
    const out = await handle(
      {
        raw,
        signature: req.headers['x-hub-signature-256'],
        event: req.headers['x-github-event'],
        delivery: req.headers['x-github-delivery'],
      },
      {
        appId: process.env.GITHUB_APP_ID,
        privateKey: pem(process.env.GITHUB_PRIVATE_KEY),
        secret: process.env.GITHUB_WEBHOOK_SECRET,
        index: new Index(),
      }
    );
    return send(res, out.status, JSON.stringify(out.body), 'application/json');
  } catch (e) {
    /*
     * 500, and GitHub will retry the delivery. The alternative — 200 on a failure — makes a broken
     * app look healthy in its own deliveries page, which is the worst place to be lied to.
     */
    console.error('webhook', e);
    return send(res, 500, JSON.stringify({ ok: false, reason: e.message }), 'application/json');
  }
}

module.exports = handler;
module.exports.handler = handler;

// Only listen when run directly. Imported — by a host, or by server.test.js — it is just a function.
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => console.log(`stakeout  http://localhost:${PORT}`));
}
