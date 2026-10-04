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

  await it('an unknown binary built for another platform is counted as such — still unknown', async () => {
    const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: {
      '': { name: 'x' },
      'node_modules/@stakeout-test/darwin-arm64': { version: '1.0.0', os: ['darwin'], cpu: ['arm64'], optional: true },
      'node_modules/@stakeout-test/linux-x64-musl': { version: '1.0.0', os: ['linux'], cpu: ['x64'], libc: ['musl'], optional: true },
      'node_modules/@stakeout-test/linux-x64-gnu': { version: '1.0.0', os: ['linux'], cpu: ['x64'], libc: ['glibc'], optional: true },
      'node_modules/@stakeout-test/native': { version: '2.0.0', hasInstallScript: true },
    } });
    const s = await serve((req, res) => lockfile(req, res));
    try {
      const r = await (await post(`${s.url}/`, { lockfile: lock })).json();
      assert.equal(r.unknown, 4, 'a binary for another platform was counted as known');
      assert.deepEqual(r.installScripts, ['@stakeout-test/native@2.0.0'], 'an install script was not named as unwatched');
      assert.equal(r.installScriptCount, 1);
      assert.equal(r.otherPlatform, 2);
      assert.deepEqual(r.otherPlatformSample.sort(), ['@stakeout-test/darwin-arm64@1.0.0', '@stakeout-test/linux-x64-musl@1.0.0']);
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

  await it('a pair the live watcher already ran is answered from that record — nothing runs, and it says only changes are kept', async () => {
    let ran = false;
    const watched = { pairs: {
      'source-map-js': { '1.2.1→1.2.2': { severity: 'alarming', reasons: ['builds and runs code that did not exist in the source (Function)'], gained: { exec: { added: ['{"how":"Function","sample":"return 0"}'], removed: [] }, 'install.proc': { added: ['{"argv":["sh","-c","node x.js"]}'], removed: [] } }, watchedAt: '2026-10-04T06:40:39.084Z' } },
      chalk: { '5.3.0→5.4.0': { severity: 'none' } },
    } };
    const s = await serve((req, res) => watch(req, res, { adapter: { boot: async () => { ran = true; } }, skipLimits: true, watched, registry: async () => { ran = true; return { ok: true }; } }));
    try {
      const r = await (await post(`${s.url}/`, { pkg: 'source-map-js', from: '1.2.1', to: '1.2.2' })).json();
      assert.match(r.from, /live watch/);
      assert.equal(r.severity, 'alarming');
      assert.equal(r.onlyChanges, true);
      assert.deepEqual(r.after.exec, [{ how: 'Function', sample: 'return 0' }], 'the evidence did not come back as the page can draw it');
      assert.deepEqual(r.after.install.proc, [{ argv: ['sh', '-c', 'node x.js'] }]);
      assert.deepEqual(r.before.exec, []);
      const same = await (await post(`${s.url}/`, { pkg: 'chalk', from: '5.3.0', to: '5.4.0' })).json();
      assert.equal(same.severity, 'none');
      assert.match(same.summary, /behaved the same/);
      assert.equal(ran, false, 'a pair already on record was run or looked up again');
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

  await it('an install script the index watched is described; one it did not is only named', () => {
    const { installWatched } = require('./yours');
    const idx = { lookup: (n, v) => (n === 'core-js' && v === '3.38.1' ? { install: { env: ['CI', 'ADBLOCK'], proc: [{ argv: ['sh', '-c', 'node postinstall.js'] }] } } : n === 'esbuild' ? { env: [] } : null) };
    const out = installWatched(new Set(['core-js@3.38.1', 'esbuild@0.25.0', 'never@1.0.0']), idx);
    assert.deepEqual(Object.keys(out), ['core-js@3.38.1'], 'an entry without an install phase was described as watched');
    assert.deepEqual(out['core-js@3.38.1'].env, ['CI', 'ADBLOCK']);
    assert.deepEqual(out['core-js@3.38.1'].proc, ['sh -c node postinstall.js']);
  });

  await it('a Nebius at capacity is said in words — not the Sandboxes API\'s own error text', async () => {
    const busy = Object.assign(new Error('sandboxes POST /v1/instances -> 429: {"status": 429}'), { status: 429 });
    const adapter = { supports: ['nodert'], boot: async () => { throw busy; } };
    const s = await serve((req, res) => watch(req, res, { adapter, skipLimits: true, registry: async () => ({ ok: true }) }));
    const err = console.error; console.error = () => {};
    try {
      const r = await post(`${s.url}/`, { pkg: 'stakeout-never-indexed-pkg', from: '1.0.0', to: '1.0.1' });
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.match(body.error, /at capacity right now/);
      assert.doesNotMatch(body.error, /v1\/instances|429|\{/);
    } finally { s.close(); console.error = err; }
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
