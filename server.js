/* STAKEOUT — zero-dependency dev server. node server.js -> http://localhost:8791 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { SimulatedSandboxes } = require('./adapters/simulated');
const { runAll, runPair } = require('./runPair');
const { judgeRun } = require('./judge');
const { lookUp } = require('./evidence/tavily');
const { observePackage, bestStrategy } = require('./observe');
const { diff } = require('./differ/diff');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('./corpus');
const { STRATEGIES } = require('./transcript/schema');

const PORT = Number(process.env.PORT) || 8791;
// Resolved from this file, so it is correct whether started with `npm start` from the repo root or
// imported by a host that runs from somewhere else entirely.
const PUBLIC = path.join(__dirname, 'public');
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
const REAL_JOBS = require('./scripts/survey').PAIRS;

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
      // ?strategy= lets the page read the same corpus three ways. Anything it does not recognise
      // falls through to the strongest the adapter supports, rather than failing the run.
      const want = STRATEGIES.includes(url.searchParams.get('strategy'))
        ? url.searchParams.get('strategy')
        : undefined;
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
              sandboxUsd: Number((r.twinsForked * 0.0146).toFixed(2)),
              modelUsd: judged.costUsd,
              modelCalls: judged.modelCalls,
              accused: judged.accused,
              simulatedJudgement: judged.simulated,
              costUsd: Number((r.twinsForked * 0.0146 + judged.costUsd).toFixed(2)),
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

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'no', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
}

module.exports = handler;
module.exports.handler = handler;

// Only listen when run directly. Imported — by a host, or by server.test.js — it is just a function.
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => console.log(`stakeout  http://localhost:${PORT}`));
}
