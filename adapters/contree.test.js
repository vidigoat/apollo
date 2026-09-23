/**
 * The real sandbox adapter, tested without a sandbox.
 *
 *   node adapters/contree.test.js
 *
 * ── What changed, and why the stub is shaped the way it is ──────────────────
 *
 * The previous version of this file tested an adapter written against an API that did not exist,
 * with a stub that answered in the shapes that adapter expected. So it passed, perfectly, for a
 * week, while every real call 404'd: a stub written from the same guess as the code cannot find the
 * guess. That is the whole weakness of testing an integration against your own idea of it.
 *
 * This stub is built from the official client instead — `contree-sdk` 0.3.6 — so its routes,
 * headers and response shapes are the service's, not ours:
 *
 *     GET  /v1/whoami                          → { permissions, limits, operations_stat }
 *     POST /v1/images/import                   → { uuid }     (an operation)
 *     POST /v1/files            octet-stream   → { uuid, sha256 }
 *     GET  /v1/files/{sha256}                  → { uuid, sha256 } | 404
 *     POST /v1/instances                       → { uuid }     (an operation)
 *     GET  /v1/operations/{uuid}               → { kind, status, metadata.result, result.image }
 *     GET  /v1/inspect/{image}/download?path=  → the file's bytes | 404
 *
 * Every request carries `Authorization: Bearer <key>` and `Project: <id>`, and the second one is
 * checked here because it is the one the first version never sent.
 *
 * The live half — does the service actually behave like its own client says — is `npm run
 * preflight`, which calls /v1/whoami and reports the account's permissions in words.
 */

const assert = require('node:assert');
const { ConTreeSandboxes, BASE, IN_VM, decodeStream } = require('./contree');
const { SimulatedSandboxes } = require('./simulated');

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

const b64 = (s) => Buffer.from(s).toString('base64');

/**
 * A stub Token Factory Sandboxes service.
 *
 * Operations complete on their second poll, so the polling loop is exercised rather than skipped.
 * `report` decides what the probe "wrote" inside the twin: a transcript, junk, or nothing at all.
 */
function stubService({ report = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] }, exitCode = 0, failImport = false } = {}) {
  const seen = [];
  const ops = new Map();
  let n = 0;
  const id = (p) => `${p}-${++n}`;

  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const route = u.pathname.replace(/^\/sandboxes/, '');
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body || null;
    seen.push({ url, route, method: opts.method || 'GET', headers: opts.headers || {}, body, query: u.searchParams });

    if (route === '/v1/whoami') {
      return reply(200, { permissions: { spawn: true, import: true }, limits: { instance_max_concurrency: 50 } });
    }
    if (route === '/v1/images/import' && opts.method === 'POST') {
      const op = id('op');
      ops.set(op, { polls: 0, done: failImport
        ? { kind: 'image_import', status: 'FAILED', error: 'registry unreachable' }
        : { kind: 'image_import', status: 'SUCCESS', result: { image: 'img-node22', tag: null } } });
      return reply(200, { uuid: op });
    }
    if (route.startsWith('/v1/files/')) return reply(404, { status: 404, error: 'not found' });
    if (route === '/v1/files' && opts.method === 'POST') return reply(200, { uuid: id('file'), sha256: 'x' });
    if (route === '/v1/instances' && opts.method === 'POST') {
      const op = id('op');
      const image = body.disposable ? null : id('img');
      const isRunner = body.command === 'node';
      ops.set(op, {
        polls: 0,
        image,
        isRunner,
        done: {
          kind: 'instance',
          status: exitCode === 0 ? 'SUCCESS' : 'FAILED',
          metadata: {
            command: body.command,
            result: {
              state: { exit_code: exitCode, timed_out: false },
              stdout: { value: b64(isRunner ? 'hello from the package\n' : 'added 1 package\n'), encoding: 'base64' },
              stderr: { value: '', encoding: 'base64' },
            },
          },
          result: { image, tag: null },
        },
      });
      return reply(200, { uuid: op });
    }
    const opMatch = route.match(/^\/v1\/operations\/(.+)$/);
    if (opMatch) {
      const op = ops.get(opMatch[1]);
      if (!op) return reply(404, { status: 404, error: 'no such operation' });
      op.polls++;
      if (op.polls < 2) return reply(200, { kind: op.done.kind, status: 'EXECUTING' });
      return reply(200, op.done);
    }
    const inspect = route.match(/^\/v1\/inspect\/([^/]+)\/download$/);
    if (inspect) {
      const wanted = u.searchParams.get('path');
      if (wanted !== IN_VM.report || report === null) return reply(404, { status: 404, error: 'no such file' });
      return reply(200, typeof report === 'string' ? report : JSON.stringify(report));
    }
    return reply(404, { status: 404, error: `unstubbed ${route}` });
  };

  return { fetchImpl, seen };
}

const adapter = (svc, o = {}) =>
  new ConTreeSandboxes({ apiKey: 'test-key', projectId: 'aiproject-test', fetchImpl: svc.fetchImpl, sleep: async () => {}, ...o });

(async () => {
  console.log('contree adapter — against the service as its own client describes it');

  await it('refuses to exist without a key, or without a project, rather than failing later', () => {
    assert.throws(() => new ConTreeSandboxes({ apiKey: '', projectId: 'p' }), /NEBIUS_API_KEY/);
    assert.throws(() => new ConTreeSandboxes({ apiKey: 'k', projectId: '' }), /NEBIUS_PROJECT_ID/);
  });

  await it('talks to the real host, with the Project header the first version never sent', async () => {
    assert.equal(BASE, 'https://api.tokenfactory.nebius.com/sandboxes');
    const svc = stubService();
    await adapter(svc).whoami();
    const [req] = svc.seen;
    assert.ok(req.url.startsWith('https://api.tokenfactory.nebius.com/sandboxes/v1/whoami'), req.url);
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(req.headers.project, 'aiproject-test', 'no Project header — the service answers 401 without it');
  });

  await it('boot imports Node, uploads the probe, and returns the SETUP image as the checkpoint', async () => {
    const svc = stubService();
    const a = adapter(svc);
    const checkpoint = await a.boot();

    const imp = svc.seen.find((s) => s.route === '/v1/images/import');
    // Absolute, as the live endpoint requires: the bare form was refused ("Image URL must be absolute").
    assert.equal(imp.body.registry.url, 'docker://docker.io/library/node:22-slim');

    const setup = svc.seen.find((s) => s.route === '/v1/instances');
    assert.equal(setup.body.image, 'img-node22', 'setup did not start from the imported image');
    assert.equal(setup.body.disposable, false, 'a disposable setup run leaves no image to fork from');
    assert.ok(setup.body.files[IN_VM.probe], 'the probe was not placed in the image');

    assert.match(checkpoint, /^img-/);
    assert.notEqual(checkpoint, 'img-node22', 'the checkpoint must be the image AFTER setup, not the bare one');
  });

  await it('forking costs nothing: N twins are N references to one image', async () => {
    const svc = stubService();
    const a = adapter(svc);
    const checkpoint = await a.boot();
    const before = svc.seen.length;
    const twins = await a.fork(checkpoint, 2);
    assert.equal(svc.seen.length, before, 'forking made an API call');
    assert.equal(twins.length, 2);
    assert.ok(twins.every((t) => t.from === checkpoint));
    assert.notEqual(twins[0].id, twins[1].id);
  });

  await it('install carries its image forward, so the import runs where the package now is', async () => {
    const svc = stubService();
    const a = adapter(svc);
    const [twin] = await a.fork(await a.boot(), 1);
    await a.run(twin, '', { step: 'install', pkg: 'left-pad', version: '1.3.0' });
    await a.run(twin, '', { step: 'import', pkg: 'left-pad' });

    const spawns = svc.seen.filter((s) => s.route === '/v1/instances');
    const [setup, install, imp] = spawns;
    assert.deepEqual(install.body.args.slice(0, 2), ['install', 'left-pad@1.3.0']);
    assert.equal(install.body.cwd, IN_VM.twin);
    assert.notEqual(imp.body.image, setup.body.image, 'the import started from the pre-install image');
  });

  await it('the report is read out of the image the run left behind, not taken from stdout', async () => {
    const svc = stubService({ report: { net: [{ host: 'evil.example', port: 443 }], dns: ['evil.example'], fs: [], env: ['AWS_SECRET_ACCESS_KEY'], proc: [], exec: [] } });
    const a = adapter(svc);
    const [twin] = await a.fork(await a.boot(), 1);
    await a.run(twin, '', { step: 'install', pkg: 'p', version: '1.0.0' });
    const r = await a.run(twin, '', { step: 'import', pkg: 'p' });

    const dl = svc.seen.find((s) => /\/download$/.test(s.route));
    assert.equal(dl.query.get('path'), IN_VM.report);
    assert.deepEqual(r.observed.env, ['AWS_SECRET_ACCESS_KEY']);
    assert.equal(r.observed.net[0].host, 'evil.example');
    assert.equal(r.stdout, 'hello from the package\n', 'stdout was not decoded from base64');
  });

  await it('no report is null — "we did not see" — never an empty transcript', async () => {
    const svc = stubService({ report: null });
    const a = adapter(svc);
    const [twin] = await a.fork(await a.boot(), 1);
    const r = await a.run(twin, '', { step: 'import', pkg: 'p' });
    assert.strictEqual(r.observed, null);
  });

  await it('a report the package overwrote with junk is null, not trusted', async () => {
    for (const junk of ['not json', '{"net":"everything is fine"}', '[]']) {
      const svc = stubService({ report: junk });
      const a = adapter(svc);
      const [twin] = await a.fork(await a.boot(), 1);
      const r = await a.run(twin, '', { step: 'import', pkg: 'p' });
      assert.strictEqual(r.observed, null, `trusted a report of ${JSON.stringify(junk)}`);
    }
  });

  await it('an empty report is an empty transcript, not a missing one', async () => {
    const svc = stubService();
    const a = adapter(svc);
    const [twin] = await a.fork(await a.boot(), 1);
    const r = await a.run(twin, '', { step: 'import', pkg: 'p' });
    assert.deepEqual(r.observed, { net: [], dns: [], fs: [], env: [], proc: [], exec: [] });
  });

  await it('a package that fails to install is a result about that version, not an exception', async () => {
    const svc = stubService({ exitCode: 1 });
    const a = adapter(svc);
    // Boot needs a successful setup, so boot on a healthy service and install on a failing one.
    const healthy = stubService();
    const b = adapter(healthy);
    const checkpoint = await b.boot();
    a.checkpoint = checkpoint;
    const [twin] = await a.fork(checkpoint, 1);
    const r = await a.run(twin, '', { step: 'install', pkg: 'broken', version: '0.0.1' });
    assert.equal(r.code, 1);
  });

  await it('an import that fails says so, instead of producing a checkpoint from nothing', async () => {
    const svc = stubService({ failImport: true });
    await assert.rejects(() => adapter(svc).boot(), /registry unreachable/);
  });

  await it('will not run in a twin it already gave back', async () => {
    const svc = stubService();
    const a = adapter(svc);
    const [twin] = await a.fork(await a.boot(), 1);
    await a.discard(twin);
    await assert.rejects(() => a.run(twin, '', { step: 'import', pkg: 'p' }), /discarded/);
    assert.equal(a.open, 0);
  });

  await it('an API failure names the call and what came back', async () => {
    const a = new ConTreeSandboxes({
      apiKey: 'k', projectId: 'p', sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"status":403,"error":"Insufficient permissions: spawn"}' }),
    });
    await assert.rejects(() => a.boot(), /POST \/v1\/images\/import -> 403: .*Insufficient permissions/);
  });

  await it('the two adapters are interchangeable, method for method', () => {
    const real = Object.getOwnPropertyNames(ConTreeSandboxes.prototype);
    const sim = Object.getOwnPropertyNames(SimulatedSandboxes.prototype);
    for (const m of ['boot', 'fork', 'run', 'discard']) {
      assert.ok(real.includes(m), `ConTreeSandboxes has no ${m}()`);
      assert.ok(sim.includes(m), `SimulatedSandboxes has no ${m}()`);
    }
  });

  await it('streams decode whichever way the service encoded them', () => {
    assert.equal(decodeStream({ value: b64('é ok'), encoding: 'base64' }), 'é ok');
    assert.equal(decodeStream({ value: 'plain', encoding: 'ascii' }), 'plain');
    assert.equal(decodeStream(null), '');
  });

  await it('an image reference is normalised the way the SDK does it', () => {
    const { ociUrl } = require('./contree');
    assert.equal(ociUrl('node:22-slim'), 'docker://docker.io/library/node:22-slim');
    assert.equal(ociUrl('python:3.12-slim'), 'docker://docker.io/library/python:3.12-slim');
    assert.equal(ociUrl('bitnami/node:20'), 'docker://docker.io/bitnami/node:20');
    assert.equal(ociUrl('ghcr.io/x/y:1'), 'docker://ghcr.io/x/y:1');
    assert.equal(ociUrl('docker://docker.io/library/node:22'), 'docker://docker.io/library/node:22');
  });

  console.log(`\n${passed} passed`);
})();
