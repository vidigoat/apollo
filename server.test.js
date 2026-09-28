/**
 * The API contract.
 *
 * There is a gap that no other suite covers. `ui.test.js` drives the interface, but it builds the
 * payload itself — so if the server stops sending a field the page reads, the interface test still
 * passes and the page silently renders a blank. That is exactly the failure that only shows up in
 * front of an audience.
 *
 * So this runs the actual server over actual HTTP and checks two things:
 *
 *   1. Every `data.<field>` the run section reads is really in the response.
 *   2. Every per-package field the renderer touches is on every pair.
 *
 * The first is derived from the component's own source rather than typed out, so adding a field to
 * the page and forgetting to send it fails here instead of on stage.
 *
 * Run: node server.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
// The section that renders a run. Derived from, rather than a copy of, what the page needs.
const APP = fs.readFileSync(path.join(__dirname, 'web', 'src', 'sections', 'Run.jsx'), 'utf8');

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

  await it('every top-level field the run section reads is actually sent', () => {
    // Derived from the source, so a new field on the page cannot be forgotten here.
    const read = [...APP.matchAll(/\bdata\.([a-zA-Z]+)/g)].map((m) => m[1]);
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

  await it('every verdict belongs to the package it is shown under', async () => {
    /*
     * This shipped, and it is the kind of wrong that looks right.
     *
     * The judgement cache keyed on the evidence and not on the package name, and `tiny-glob` and
     * `lru-memo` both start writing to a cache file — identical evidence after normalisation. So
     * the hosted demo served one verdict twice: the row said lru-memo, the object inside said
     * `"pkg": "tiny-glob"`, and the model's own reasoning text discussed the other package. It was
     * counted as a live, paid call in `modelCalls` and `modelUsd`.
     *
     * The prompt opens with `Package: ${d.pkg}`, so two packages are two questions. Checked here,
     * over real HTTP, because the cache is the thing being trusted and a unit test of the key would
     * not have noticed the entries that were already published under the old one.
     */
    for (const p of run.pairs) {
      if (!p.judgement?.judged) continue;
      assert.equal(
        p.judgement.pkg,
        p.pkg,
        `${p.pkg} is showing a verdict that was produced about ${p.judgement.pkg}`
      );
    }
  });

  await it('no two findings share one verdict', () => {
    // The same failure seen from the other side: if two rows carry byte-identical model reasoning,
    // one of them is being answered with the other's homework.
    const seen = new Map();
    for (const p of run.pairs.filter((x) => x.diff.changed)) {
      const reasoning = (p.judgement?.spend || []).map((s) => s.reasoning || '').join('|');
      if (!reasoning.trim()) continue;
      if (seen.has(reasoning)) {
        assert.fail(`${seen.get(reasoning)} and ${p.pkg} were given the same model reasoning verbatim`);
      }
      seen.set(reasoning, p.pkg);
    }
  });

  await it('the fixture run says it is a fixture', () => {
    assert.equal(run.live, false, 'a fixture that does not declare itself is the thing this repo is against');
  });

  await it('the page and its assets are served', async () => {
    // The built site if there is one, and the data file both it and the API read either way.
    const built = fs.existsSync(path.join(__dirname, 'dist', 'index.html'));
    const want = built
      ? [['/', 'text/html'], ['/fleet-demo.json', 'application/json']]
      : [['/fleet-demo.json', 'application/json']];
    for (const [p, type] of want) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} returned ${r.status}`);
      assert.match(r.headers.get('content-type'), new RegExp(type));
    }
  });

  await it('every asset the built page references is committed, not just built and left untracked', async () => {
    // The bug this guards: a rebuild produces fresh content-hashed bundle names, index.html is
    // committed with the new names, and the bundles themselves are never `git add`ed. Every suite
    // and the dev server read the working tree, where the files exist, so everything is green — but
    // a fresh clone serves an index.html whose one <script> 404s. The built site is committed on
    // purpose (see the note in .gitignore), so "referenced" must mean "tracked", not "on disk".
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(distDir, 'index.html'))) return; // nothing built to check
    const tracked = new Set(
      execFileSync('git', ['-C', __dirname, 'ls-files', 'dist'], { encoding: 'utf8' })
        .split('\n').filter(Boolean),
    );
    // index.html names its entry bundle and stylesheet; the entry bundle then imports further
    // chunks at runtime. Both must ship, so the invariant is the whole built asset dir is tracked.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [path.relative(__dirname, full)];
    });
    const untracked = walk(path.join(distDir, 'assets')).filter((f) => !tracked.has(f));
    assert.deepEqual(untracked, [], `built bundles were left uncommitted: ${untracked.join(', ')}`);
    // And what index.html names by hand must actually serve, not just exist as a file.
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    for (const ref of [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1])) {
      const r = await get(`/${ref}`);
      assert.equal(r.status, 200, `index.html references /${ref}, which the server returned ${r.status} for`);
    }
  });

  await it('it will not serve files outside the roots it was given', async () => {
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

  await it('a strategy nobody defines is refused, not silently upgraded to the strongest one', async () => {
    /*
     * `?strategy=typo` used to fall through to whatever the adapter defaults to, which is `ebpf` —
     * the STRONGEST strategy and the one that has never actually run. The response came back
     * stamped `"strategy": "ebpf"`, so every claim in it carried a watcher that had not watched it.
     *
     * A silent fallback to the weakest strategy would be a smaller version of the same bug. The
     * only honest answer to a name nobody defines is to say so.
     */
    const { STRATEGIES } = require('./transcript/schema');

    for (const bad of ['typo', '../../etc', '', 'EBPF', 'nodert '] ) {
      const res = await get(`/api/run?strategy=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `?strategy=${bad} answered ${res.status}`);
      const out = await res.json();
      assert.match(out.error, /No strategy called/);
      assert.deepEqual(out.strategies, STRATEGIES, 'it does not say which names exist');
    }

    // Every real one still runs, and reports itself.
    for (const good of STRATEGIES) {
      const out = await json(`/api/run?strategy=${good}`);
      assert.equal(out.strategy, good, `asked for ${good} and got ${out.strategy}`);
    }

    // And asking for nothing is still allowed — it is a different thing from asking for nonsense.
    assert.equal((await get('/api/run')).status, 200);
  });

  await it('/api/index describes the published index, and the file it describes is really there', async () => {
    /*
     * The page makes an offer on the strength of this: point `--index` at this URL and get these
     * packages without installing anything. Every figure in that offer comes from here, so a wrong
     * answer here is a wrong promise on the page — and the specific way it would go wrong is the
     * header saying `published: true` about a file that 404s.
     */
    const meta = await json('/api/index');
    if (!meta.published) {
      // A checkout that has not run `npm run index:publish`. It says so and offers nothing.
      assert.match(meta.how, /index:publish/);
      return;
    }

    assert.ok(meta.counts.packages > 0 && meta.counts.versions > 0);
    assert.ok(meta.gzipBytes > 0 && meta.gzipBytes < meta.bytes, 'the sizes do not describe a real file');
    assert.ok(Array.isArray(meta.strategies) && meta.strategies.length);

    // The URL it offers has to actually serve the index — and serve the same index.
    const res = await get(meta.url);
    assert.equal(res.status, 200, `${meta.url} is offered by /api/index and answers ${res.status}`);
    const doc = await res.json();
    assert.deepEqual(doc.counts, meta.counts, 'the header and the file disagree about what is in it');
    assert.equal(Object.keys(doc.packages).length, meta.counts.packages);
  });

  await it('the offered index says what watched it, in the same words the code does', async () => {
    /*
     * `canSee` travels with the index so a reader can disbelieve it. If the published table and
     * this build's table disagree, somebody is reading somebody else's recording with code that
     * means something different by the same field — which is how `nodert`'s `fs: true` survived a
     * correction for months.
     */
    const meta = await json('/api/index');
    if (!meta.published) return;
    const { CAN_SEE } = require('./transcript/schema');
    for (const s of meta.strategies) {
      assert.deepEqual(meta.canSee[s], CAN_SEE[s], `the published table for ${s} is not this build's`);
    }
  });

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

  await it('everything the server reads at runtime is in the deployed bundle', () => {
    /*
     * Vercel traces what a function `require`s. It cannot see `fs.readFile(path.join(PUBLIC, rel))`
     * — that path is assembled at runtime — so every directory this server reads off disk has to be
     * named in `includeFiles` or it is simply absent in production.
     *
     * The failure is invisible locally and total when hosted: the page 404s on its own stylesheet
     * and a judge opening the demo URL sees unstyled text. Nebius asks for a working demo URL, and
     * a demo URL showing something the repository does not do is worse than no demo URL.
     *
     * `index/data` is deliberately NOT here. It is gitignored — a published index is its own
     * artefact, see PLAN.md — so the hosted fleet page answers from the committed scan's own
     * recorded index size and says so.
     */
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
    const included = cfg.functions?.['api/index.js']?.includeFiles || '';
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

    for (const dir of ['public', 'judge/verdicts']) {
      assert.ok(
        included.includes(dir),
        `server.js reads ${dir}/ at runtime but vercel.json does not ship it`
      );
    }
    // And the bundled fleet scan really is in the directory that gets shipped.
    assert.ok(src.includes("'fleet-demo.json'"), 'the fallback scan is no longer read from PUBLIC');
    assert.ok(
      fs.existsSync(path.join(__dirname, 'public', 'fleet-demo.json')),
      'the hosted demo has no scan to fall back to'
    );
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

  await it('a deploy cannot carry this machine off the machine', () => {
    /*
     * This happened. The first production deploy published `local/fleet.json` — one laptop's home
     * directory, 76 repository names and the paths they sit at — on a URL anyone could open, and
     * the pages all looked correct, because the only thing that changed was whose fleet it was.
     *
     * The cause is worth stating plainly: the Vercel CLI does not read `.gitignore`. Everything
     * this repository is careful never to commit was uploaded anyway.
     */
    const ignore = path.join(__dirname, '.vercelignore');
    assert.ok(fs.existsSync(ignore), 'there is no .vercelignore, so .gitignore is the only guard — and a deploy ignores it');

    const lines = fs.readFileSync(ignore, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    for (const kept of ['.env', 'local/', 'index/data/']) {
      assert.ok(lines.includes(kept), `${kept} is gitignored but would still be uploaded to a public URL`);
    }
  });

  await it('the built site is committed, so a fresh clone can just start it', () => {
    /*
     * `dist/` is a build artefact and committing one is normally a smell. It is committed here for
     * a specific reason: the README promises `npm install && npm start` with nothing to install and
     * nothing to build, and a judge who clones this at 1am should get the site, not a blank page and
     * an instruction to go and install a toolchain first. The tool keeps its promise; the website
     * pays for it by being checked in.
     */
    /*
     * Asked of GIT, not of this disk.
     *
     * `fs.existsSync` is true on any machine that has ever run a build and says nothing whatsoever
     * about a clone. `dist/` was in .gitignore the entire time, so this check passed everywhere it
     * did not matter and failed only where it did — which is how the sibling project's identical
     * check was found to be passing over an identical hole tonight.
     */
    const tracked = execFileSync('git', ['ls-files', 'dist/index.html'], {
      cwd: __dirname, encoding: 'utf8',
    }).trim();
    assert.ok(tracked, 'nothing serves `/` on a fresh clone: dist/index.html is not in git');

    const index = path.join(__dirname, 'dist', 'index.html');
    assert.ok(fs.existsSync(index), 'dist/index.html is missing — `npm start` after a clone shows nothing');

    const html = fs.readFileSync(index, 'utf8');
    for (const ref of [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1])) {
      assert.ok(
        fs.existsSync(path.join(__dirname, 'dist', ref)),
        `the built page asks for ${ref}, which was not committed`
      );
    }
  });

  await it('the drill-down the documents point at returns a channel strip, or says why not', async () => {
    /*
     * `docs/SUBMISSION.md` and `docs/DEEP-DIVE.md` both used to promise "clicking a project gives
     * its packages with a six-slot channel strip". Nothing in the rebuilt site calls this endpoint,
     * so the documents now name it directly — which makes it a thing a reader will type, and
     * therefore a thing worth checking.
     *
     * Two honest answers, depending on where the scan came from. On a machine that took its own
     * scan, the packages. On the hosted one, where the scan is portable and its paths are withheld,
     * a plain refusal rather than an invented tree.
     */
    const res = await get('/api/project?at=0');
    assert.ok([200, 404].includes(res.status), `it answered ${res.status}`);
    const out = await res.json();

    if (res.status === 404) {
      assert.match(out.error, /somewhere else|no such project/i, 'it refused without saying why');
      return;
    }

    assert.equal(typeof out.name, 'string');
    assert.ok(Array.isArray(out.packages) && out.packages.length, 'a project with no packages in it');

    const observed = out.packages.find((p) => p.observed);
    if (!observed) return; // a project none of whose packages the index has seen; still honest

    // The strip itself: six channels, and what the strategy could see in each of them.
    const { CHANNELS } = require('./index/schema');
    for (const channel of CHANNELS) {
      assert.equal(typeof observed.counts[channel], 'number', `no count for ${channel}`);
      assert.ok(channel in observed.canSee, `canSee says nothing about ${channel}`);
    }

    /*
     * And the third state, which is the one the whole project is about: a channel nothing was
     * watching is named, rather than counted as quiet. `nodert` hooks writes, so the filesystem is
     * a blind spot and has to appear as one.
     */
    assert.ok(Array.isArray(observed.blindTo), 'an entry with no blind spots listed at all');
    if (observed.strategy === 'nodert') {
      assert.ok(observed.blindTo.includes('fs'), "nodert reported no blind spot on a channel it only half watches");
      assert.equal(observed.canSee.fs, 'writes');
    }
  });

  await it('the hosted routes keep their own path', () => {
    /*
     * Also happened. A `{"source": "/(.*)", "destination": "/api"}` rewrite reaches the function
     * having replaced the path with `/api`, so every route inside the server saw one pathname and
     * fell through to "not found". `public/` is served from the filesystem before rewrites are
     * considered, so the pages were fine and only the data was missing.
     */
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
    for (const r of cfg.rewrites || []) {
      assert.ok(
        !/^\/api\/?$/.test(r.destination),
        `the rewrite ${r.source} -> ${r.destination} throws the pathname away before the server sees it`
      );
    }
    const catchAll = path.join(__dirname, 'api', '[...path].js');
    assert.ok(fs.existsSync(catchAll), 'nothing serves /api/<anything> on the deployment');
    assert.ok(
      cfg.functions?.['api/[...path].js']?.includeFiles,
      'the catch-all is deployed without the files it reads'
    );
  });

  stop();
  console.log(`\n${passed} passed`);
})();
