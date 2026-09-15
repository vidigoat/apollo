/* CASSANDRA — zero-dependency dev server. node server.js  ->  http://localhost:8791 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { runPremortem } = require('./orchestrator');

const PORT = 8791;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/plan') return send(res, 200, JSON.stringify(engine.plan()), 'application/json');
    if (url.pathname === '/api/report') return send(res, 200, JSON.stringify(engine.report()), 'application/json');

    // A genuine run: boots a checkpoint, forks it in waves, and lets the probes decide.
    if (url.pathname === '/api/run') {
      const clean = url.searchParams.get('clean') === '1';
      // A healthy build is the same corpus with nothing left to find.
      const adapter = clean ? new (require('./adapters/simulated').SimulatedSandboxes)({ failing: {} }) : undefined;
      return runPremortem(adapter ? { adapter } : {})
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
  .listen(PORT, () => console.log(`cassandra  http://localhost:${PORT}`));
