/* STAKEOUT — zero-dependency dev server. node server.js -> http://localhost:8791 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { SimulatedSandboxes } = require('./adapters/simulated');
const { runAll } = require('./runPair');
const { judgeRun } = require('./judge');
const { lookUp } = require('./evidence/tavily');
const { observePackage, bestStrategy } = require('./observe');
const { diff } = require('./differ/diff');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('./corpus');
const { STRATEGIES } = require('./transcript/schema');

const PORT = Number(process.env.PORT) || 8791;
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
const REAL_JOBS = [
  ['left-pad', '1.2.0', '1.3.0'],   // observably silent at both versions
  ['debug', '4.3.4', '4.4.0'],      // genuinely active — reads DEBUG — and unchanged
  ['picocolors', '1.0.0', '1.1.1'], // the one that actually changed
];

const realAllowed = () => process.env.STAKEOUT_ALLOW_LOCAL === '1';

/**
 * The same pipeline, against the real registry, on this machine.
 *
 * Deliberately gated: these packages execute as whoever started the server, with its network and
 * its files. Nothing isolates them. See adapters/local.js.
 */
async function realRun() {
  const { LocalMachines } = require('./adapters/local');
  const machines = new LocalMachines();
  const strategy = bestStrategy(machines);
  const checkpoint = await machines.boot();
  const pairs = [];
  const started = Date.now();

  try {
    for (const [pkg, from, to] of REAL_JOBS) {
      const [a, b] = await machines.fork(checkpoint, 2);
      try {
        const [before, after] = await Promise.all([
          observePackage({ adapter: machines, branch: a, pkg, version: from, strategy }),
          observePackage({ adapter: machines, branch: b, pkg, version: to, strategy }),
        ]);
        const d = diff(before, after);
        pairs.push({
          pkg, from, to, diff: d, before, after,
          record: d.changed ? await publicRecordFor(pkg, to) : null,
          invariant: null,
        });
      } finally {
        await machines.discard(a);
        await machines.discard(b);
      }
    }

    const judged = await judgeRun(pairs);
    pairs.forEach((p, i) => { p.judgement = judged.results[i]; });

    return {
      live: true,
      tree: { total: REAL_JOBS.length, moved: REAL_JOBS.length },
      strategy,
      canSee: pairs[0]?.diff.canSee ?? null,
      twinsForked: REAL_JOBS.length * 2,
      quiet: pairs.filter((p) => !p.diff.changed).length,
      wallMs: Date.now() - started,
      sandboxUsd: 0,
      modelUsd: judged.costUsd,
      modelCalls: judged.modelCalls,
      accused: judged.accused,
      simulatedJudgement: judged.simulated,
      costUsd: judged.costUsd,
      pairs,
    };
  } finally {
    machines.cleanup();
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
  })
  .listen(PORT, () => console.log(`stakeout  http://localhost:${PORT}`));
