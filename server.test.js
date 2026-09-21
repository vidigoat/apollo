/**
 * The API contract.
 *
 * There is a gap that no other suite covers. `public/ui.test.js` drives the real interface, but it
 * builds the payload itself — so if the server stops sending a field the page reads, the interface
 * test still passes and the page silently renders a blank. That is exactly the failure that only
 * shows up in front of an audience.
 *
 * So this runs the actual server over actual HTTP and checks two things:
 *
 *   1. Every `result.<field>` that app.js reads is really in the response.
 *   2. Every per-package field the renderer touches is on every pair.
 *
 * The first is derived from app.js rather than typed out, so adding a field to the page and
 * forgetting to send it fails here instead of on stage.
 *
 * Run: node server.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const APP = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

let passed = 0;
const it = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n       ', e.message);
    process.exitCode = 1;
  }
};

const get = async (p) => fetch(`${BASE}${p}`);
const json = async (p) => (await get(p)).json();

(async () => {
  console.log('api');

  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const stop = () => server.kill();
  process.on('exit', stop);

  for (let i = 0; i < 80; i++) {
    try { if ((await get('/api/tree')).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 50));
  }

  const tree = await json('/api/tree');
  const run = await json('/api/run');

  await it('/api/tree describes the tree, and the arithmetic adds up', () => {
    assert.equal(typeof tree.total, 'number');
    assert.equal(tree.total, tree.moved + tree.unchanged, 'moved + unchanged must be the whole tree');
    assert.ok(tree.moved > 0 && tree.moved < tree.total);
  });

  await it('every top-level field app.js reads is actually sent', () => {
    // Derived from the source, so a new field on the page cannot be forgotten here.
    const read = [...APP.matchAll(/\bresult\.([a-zA-Z]+)/g)].map((m) => m[1]);
    const wanted = [...new Set(read)];
    assert.ok(wanted.length >= 5, `only found ${wanted.length} fields — the scan is probably broken`);
    const missing = wanted.filter((f) => !(f in run));
    assert.deepEqual(missing, [], `the page reads these and the server does not send them: ${missing}`);
  });

  await it('every per-package field the renderer touches is on every pair', () => {
    const required = ['pkg', 'from', 'to', 'diff', 'before', 'after', 'judgement'];
    run.pairs.forEach((p) => {
      required.forEach((f) => assert.ok(f in p, `${p.pkg} is missing ${f}`));
      ['changed', 'severity', 'reasons', 'canSee'].forEach((f) =>
        assert.ok(f in p.diff, `${p.pkg}.diff is missing ${f}`));
      ['net', 'dns', 'fs', 'env', 'proc'].forEach((f) => {
        assert.ok(Array.isArray(p.diff[f].added), `${p.pkg}.diff.${f}.added is not an array`);
        assert.ok(Array.isArray(p.diff[f].removed), `${p.pkg}.diff.${f}.removed is not an array`);
      });
    });
  });

  await it('a package that changed carries a public record; a quiet one does not', () => {
    run.pairs.forEach((p) => {
      if (p.diff.changed) assert.ok(p.record?.verdict, `${p.pkg} changed but has no public record`);
      else assert.equal(p.record, null, `${p.pkg} was quiet and still cost a lookup`);
    });
  });

  await it('the quiet majority cost nothing, and the totals say so', () => {
    const quiet = run.pairs.filter((p) => !p.diff.changed);
    quiet.forEach((p) => assert.equal(p.judgement.spend.length, 0, `${p.pkg} paid for a model it did not need`));
    assert.equal(run.quiet, quiet.length);
    assert.ok(run.modelCalls < run.pairs.length * 3, 'every package reached every model');
    assert.equal(run.costUsd, Number((run.sandboxUsd + run.modelUsd).toFixed(2)));
  });

  await it('the run reports how it watched and what that could not see', () => {
    assert.ok(['ebpf', 'proxy', 'fsdiff'].includes(run.strategy));
    assert.ok(run.canSee && typeof run.canSee.net === 'boolean');
    run.pairs.forEach((p) => assert.equal(p.diff.strategy, run.strategy,
      'a pair watched differently from the rest would be an artefact, not a finding'));
  });

  await it('a simulated judgement is declared at the top level too', () => {
    assert.equal(typeof run.simulatedJudgement, 'boolean');
    if (run.simulatedJudgement) {
      assert.ok(run.pairs.some((p) => p.judgement.spend.some((s) => s.simulated)));
    }
  });

  await it('the live run is off unless it was deliberately turned on', async () => {
    // The server under test is started without STAKEOUT_ALLOW_LOCAL. Running real packages must
    // never be something you get by default — they execute as whoever started this.
    assert.equal(tree.realAllowed, false);
    const r = await get('/api/real');
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.match(body.error, /STAKEOUT_ALLOW_LOCAL/);
    assert.match(body.error, /adapters\/local\.js/, 'the refusal should say where to read first');
  });

  await it('the fixture run says it is a fixture', () => {
    assert.equal(run.live, false, 'a fixture that does not declare itself is the thing this repo is against');
  });

  await it('the page and its assets are served', async () => {
    for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} returned ${r.status}`);
      assert.match(r.headers.get('content-type'), new RegExp(type));
    }
  });

  await it('it will not serve files outside public/', async () => {
    for (const p of ['/../server.js', '/../../etc/passwd', '/..%2fserver.js']) {
      const r = await get(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} returned ${r.status}`);
      const body = await r.text();
      assert.ok(!body.includes('NEBIUS_API_KEY'), `${p} leaked source`);
    }
  });

  await it('an unknown path is a 404, not a crash', async () => {
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await get('/api/nope')).status, 404);
  });

  /* ── the fleet ────────────────────────────────────────────────────────── */

  await it('/api/fleet is honest about having no scan, rather than inventing one', async () => {
    /*
     * There is deliberately no bundled fleet in this repository. A canned one would be a fabricated
     * number sitting underneath the page's central claim, and the honest empty state — "run the
     * scan" — is the same answer the CLI gives for a missing index.
     *
     * So the route is correct in BOTH states, and the test asserts whichever one this machine is
     * in rather than requiring a scan to exist.
     */
    const r = await get('/api/fleet');
    assert.equal(r.status, 200, 'a missing scan is not an error');
    const body = await r.json();

    if (!body.scanned) {
      assert.match(body.how, /fleet-scan/, 'it did not say how to produce one');
      return;
    }

    assert.ok(body.totals, 'a scan without totals');
    for (const k of ['repos', 'depVersions', 'distinct', 'known']) {
      assert.equal(typeof body.totals[k], 'number', `totals.${k} is missing`);
    }
    assert.ok(
      body.totals.distinct <= body.totals.depVersions,
      'more distinct packages than dependency-versions, which is arithmetically impossible'
    );
    assert.ok(
      body.totals.known <= body.totals.depVersions,
      'more questions answered than were asked'
    );
  });

  await it('/api/fleet keeps the scan-time index size apart from the live one', async () => {
    // Both halves of the reuse ratio have to be from the same instant. `stale` is how the page is
    // told the index has moved since, without that fact leaking into the arithmetic.
    const body = await json('/api/fleet');
    if (!body.scanned) return;
    assert.ok('stale' in body, 'the page cannot tell whether the scan is behind the index');
    if (body.index && body.indexNow) {
      assert.equal(body.stale, body.index.versions !== body.indexNow.versions);
    }
  });

  await it('/api/project will not read a path off the query string', async () => {
    /*
     * The route takes a position in the scan, never a directory. A `?dir=` the server happily reads
     * is a directory-traversal hole with a friendly name, and this one serves a page that is often
     * left running on a laptop.
     */
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const route = src.slice(src.indexOf("'/api/project'"), src.indexOf("'/api/project'") + 2400);
    assert.ok(!/searchParams\.get\(['"]dir/.test(route), 'the project route reads a path from the URL');

    for (const bad of ['../../etc', '/etc/passwd', 'NaN', '-1', '999999']) {
      const r = await get(`/api/project?at=${encodeURIComponent(bad)}`);
      assert.ok(r.status === 404 || r.status === 200, `unexpected ${r.status} for ${bad}`);
      if (r.status === 200) {
        const b = await r.json();
        assert.ok(!b.packages, `${bad} resolved to a real project`);
      }
    }
  });

  await it('the server is a plain handler, so a host can serve the same code', () => {
    // Nebius requires a working demo URL. The hosted deployment imports this exact function rather
    // than a second copy — a demo URL showing something the repository does not do is worse than no
    // demo URL at all.
    const mod = require('./server');
    assert.equal(typeof mod, 'function', 'server.js no longer exports a request handler');
    assert.equal(typeof mod.handler, 'function');
    assert.equal(mod.length, 2, 'a request handler takes (req, res)');
  });

  await it('importing the server does not start one', () => {
    // If requiring it bound a port, every test file and every host would fight over 8791.
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.match(src, /require\.main === module/, 'server.js listens unconditionally on import');
  });

  stop();
  console.log(`\n${passed} passed`);
})();
