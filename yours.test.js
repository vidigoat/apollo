/**
 * The two surfaces a stranger uses with their own packages — tested offline.
 *
 *   node yours.test.js
 *
 * /api/lockfile runs against the real published index; /api/watch against a scripted adapter and a
 * scripted registry, so nothing here reaches Nebius or npm. What is tested is what a stranger's
 * request can make it do: which URL it fetches, what it refuses, what it counts, and that an
 * unknown package is never reported as clean.
 */

const assert = require('node:assert');
const http = require('node:http');
const { lockfile, watch, fetchLockfile, limited, NAME, VERSION } = require('./yours');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};

const serve = async (handler) => {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const LOCK = JSON.stringify({
  name: 'x', lockfileVersion: 3,
  packages: {
    '': { name: 'x' },
    'node_modules/ms': { version: '2.1.3' },
    'node_modules/definitely-not-a-real-package-stakeout': { version: '9.9.9' },
  },
});

(async () => {
  console.log('your packages');

  await it('a pasted lockfile is resolved against the published index, and the unknown is named', async () => {
    const s = await serve((req, res) => lockfile(req, res));
    try {
      const r = await (await post(`${s.url}/`, { lockfile: LOCK })).json();
      assert.equal(r.total, 2);
      assert.ok(r.unknownSample.includes('definitely-not-a-real-package-stakeout@9.9.9'), 'an unwatched package was not reported as unknown');
      assert.equal(r.known + r.unknown, r.total);
      assert.ok(r.index.versions > 0);
      assert.match(r.note, /never that it is clean/);
    } finally { s.close(); }
  });

  await it('a repository is fetched from raw.githubusercontent.com only, by a path built here', async () => {
    const seen = [];
    const fake = async (url) => { seen.push(url); return { ok: true, status: 200, headers: new Headers(), text: async () => LOCK }; };
    const got = await fetchLockfile('https://github.com/Owner/repo.git', fake);
    assert.equal(got.repo, 'Owner/repo');
    assert.equal(seen[0], 'https://raw.githubusercontent.com/Owner/repo/HEAD/package-lock.json');
    for (const bad of ['../../etc', 'owner/..', 'http://169.254.169.254/latest', 'owner/repo/../../x', 'a b/c', '']) {
      await assert.rejects(() => fetchLockfile(bad, fake), /not a GitHub repository/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(seen.length, 1, 'a refused name still reached the network');
  });

  await it('what is not JSON, not a lockfile, or too large is refused in words', async () => {
    const s = await serve((req, res) => lockfile(req, res));
    try {
      assert.equal((await post(`${s.url}/`, '{nope')).status, 400);
      assert.equal((await post(`${s.url}/`, { lockfile: 'not json at all' })).status, 400);
      assert.equal((await post(`${s.url}/`, {})).status, 400);
      const big = await post(`${s.url}/`, { lockfile: 'x'.repeat(31 * 1024 * 1024) });
      assert.equal(big.status, 413);
    } finally { s.close(); }
  });

  await it('a watch refuses a name or a version that is not one, before anything runs', async () => {
    assert.ok(NAME.test('@babel/core') && NAME.test('left-pad') && !NAME.test('../x') && !NAME.test('A B'));
    assert.ok(VERSION.test('1.2.3') && VERSION.test('1.0.0-beta.1') && !VERSION.test('latest') && !VERSION.test('^1.2.3'));
    let ran = false;
    const adapter = { boot: async () => { ran = true; } };
    const s = await serve((req, res) => watch(req, res, { adapter, skipLimits: true, registry: async () => ({ ok: true }) }));
    try {
      assert.equal((await post(`${s.url}/`, { pkg: '../etc', from: '1.0.0', to: '1.0.1' })).status, 400);
      assert.equal((await post(`${s.url}/`, { pkg: 'ms', from: 'latest', to: '2.1.3' })).status, 400);
      assert.equal((await post(`${s.url}/`, { pkg: 'ms', from: '2.1.3', to: '2.1.3' })).status, 400);
      assert.equal(ran, false, 'a sandbox was booted for a request that should never have reached it');
    } finally { s.close(); }
  });

  await it('a version the registry does not have is refused, and nothing is run', async () => {
    let ran = false;
    const adapter = { boot: async () => { ran = true; } };
    const s = await serve((req, res) => watch(req, res, { adapter, skipLimits: true, registry: async () => ({ ok: false, why: 'left-pad has no published version 9.9.9.' }) }));
    try {
      const r = await post(`${s.url}/`, { pkg: 'left-pad', from: '1.3.0', to: '9.9.9' });
      assert.equal(r.status, 404);
      assert.match((await r.json()).error, /no published version/);
      assert.equal(ran, false);
    } finally { s.close(); }
  });

  await it('two versions the index already holds are answered by lookup — no sandbox', async () => {
    const pub = require('./public/index.json');
    const versionsOf = (n) => Object.keys(pub.packages[n].versions || pub.packages[n]).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    const name = Object.keys(pub.packages).find((n) => versionsOf(n).length >= 2);
    const [from, to] = versionsOf(name);
    let ran = false;
    const s = await serve((req, res) => watch(req, res, { adapter: { boot: async () => { ran = true; } }, skipLimits: true }));
    try {
      const r = await (await post(`${s.url}/`, { pkg: name, from, to })).json();
      assert.match(r.from, /published index/);
      assert.ok(['none', 'minor', 'notable', 'alarming'].includes(r.severity), JSON.stringify(r));
      assert.equal(ran, false);
    } finally { s.close(); }
  });

  await it('a watched version that did not install is answered as not watched, never as "none"', async () => {
    const adapter = {
      supports: ['nodert'],
      boot: async () => 'checkpoint',
      fork: async (_c, n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}` })),
      run: async (_b, _cmd, ctx) => (ctx.step === 'install' ? { code: ctx.version === '5.0.10' ? 1 : 0 } : { code: 0, observed: {} }),
      discard: async () => {},
    };
    const s = await serve((req, res) => watch(req, res, { adapter, skipLimits: true, registry: async () => ({ ok: true }) }));
    try {
      const r = await post(`${s.url}/`, { pkg: 'stakeout-never-indexed-pkg', from: '5.0.9', to: '5.0.10' });
      assert.equal(r.status, 422);
      const body = await r.json();
      assert.match(body.error, /did not install/);
      assert.match(body.error, /not the same as clean/);
      assert.equal(body.severity, undefined);
    } finally { s.close(); }
  });

  await it('the hourly limits hold per caller and for the whole deployment', () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) assert.equal(limited('a', now + i), null);
    assert.match(limited('a', now + 5), /limit/);
    for (let i = 0; i < 36; i++) limited(`caller-${i}`, now + 10 + i);
    assert.match(limited('fresh', now + 100), /hourly share/);
    assert.equal(limited('fresh', now + 61 * 60 * 1000), null, 'the window never reopened');
  });

  await it('the "worth reading first" list is credentials and shells, not CI detection', () => {
    const lock = { packages: {
      'a@1.0.0': { env: ['GITHUB_ACTIONS', 'bamboo_planKey', 'FAKEROOTKEY', 'CI'] },
      'b@1.0.0': { env: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'] },
      'c@1.0.0': { proc: [{ argv: ['sh', '-c', 'curl https://x.example'] }] },
    } };
    const flagged = require('./yours').attentionFor(lock).map((x) => x.package);
    assert.deepEqual(flagged.sort(), ['b@1.0.0', 'c@1.0.0']);
  });

  console.log(`\n${passed} passed`);
})();
