/* STAKEOUT — zero-dependency dev server. node server.js -> http://localhost:8791 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { SimulatedSandboxes } = require('./adapters/simulated');
const { runAll } = require('./runPair');
const { judgeRun } = require('./judge');
const { lookUp } = require('./evidence/tavily');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('./corpus');

const PORT = 8791;
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
          packages: CHANGED.map(({ pkg, from, to }) => ({ pkg, from, to })),
        }),
        'application/json'
      );
    }

    /* A real run: fork the same checkpoint twice per package, install and import both, diff. */
    if (url.pathname === '/api/run') {
      const adapter = new SimulatedSandboxes();
      return runAll({ adapter, changed: CHANGED })
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

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'no', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  })
  .listen(PORT, () => console.log(`stakeout  http://localhost:${PORT}`));
