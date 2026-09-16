/**
 * The real sandbox adapter, tested without a sandbox.
 *
 * What is being protected: the seam. Everything above adapters/ was written against the simulated
 * one, and the whole plan for "what if Sandboxes access is refused" rests on the two being
 * interchangeable. If they drift, that is discovered here rather than at 2am on submission night.
 *
 * The other thing being protected is a distinction that is easy to lose and expensive to lose:
 * a MISSING trace is not an EMPTY trace. Empty means the package did nothing. Missing means we did
 * not watch. Flattening the second into the first turns "we could not see" into "nothing happened",
 * which is the one lie this project cannot afford.
 *
 * Run: node adapters/contree.test.js
 */

const assert = require('node:assert');
const { ConTreeSandboxes, normaliseTrace } = require('./contree');
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

/** A stub Nebius. Records every request; answers with the shapes the adapter expects. */
function stubNebius(overrides = {}) {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const path = url.replace(/^.*\/v1\/sandboxes/, '');
    seen.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });

    const reply = (obj) => ({ ok: true, json: async () => obj, text: async () => '' });
    if (overrides[path]) return reply(overrides[path]);
    if (path === '' ) return reply({ id: 'sbx_1' });
    if (path.endsWith('/checkpoint')) return reply({ id: 'ckpt_1' });
    if (path === '/fork') return reply({ id: `br_${seen.filter((s) => s.path === '/fork').length}` });
    if (path.endsWith('/exec')) return reply({ exit_code: 0, stdout: '', trace: null });
    return reply({});
  };
  return { fetchImpl, seen };
}

const adapter = (o = {}) => new ConTreeSandboxes({ apiKey: 'test-key', image: 'node:22', ...o });

(async () => {
  console.log('contree adapter');

  await it('refuses to exist without a key rather than failing later', async () => {
    assert.throws(() => new ConTreeSandboxes({ apiKey: '' }), /SimulatedSandboxes/);
  });

  await it('the two adapters are interchangeable, step for step', async () => {
    // Not an arity check — a default parameter makes Function.length lie. Drive both through the
    // same sequence and require the same shapes back, which is what the engine above depends on.
    const shapes = [];
    for (const a of [adapter(stubNebius()), new SimulatedSandboxes()]) {
      assert.ok(Array.isArray(a.supports) && a.supports.length, 'an adapter must say what it can watch');
      const ckpt = await a.boot('node:22');
      const branches = await a.fork(ckpt, 2);
      const r = await a.run(branches[0], 'node -e 0', { step: 'import', pkg: 'tiny-glob', version: '0.2.9' });
      for (const b of branches) await a.discard(b);
      shapes.push({
        checkpoint: typeof ckpt,
        branches: branches.length,
        branchHasId: branches.every((b) => typeof b.id === 'string'),
        runKeys: Object.keys(r).sort().filter((k) => k !== 'stderr').join(','),
        openAfter: a.open,
      });
    }
    assert.deepEqual(shapes[0], shapes[1], 'the adapters have drifted — the offline fallback is no longer a fallback');
  });

  await it('claims only what it can actually watch', async () => {
    assert.deepEqual(adapter(stubNebius()).supports, ['fsdiff'],
      'claiming an unproven strategy would turn "could not see" into "nothing happened"');
    assert.deepEqual(adapter({ ...stubNebius(), supports: ['ebpf', 'fsdiff'] }).supports, ['ebpf', 'fsdiff']);
    assert.match(ConTreeSandboxes.why('ebpf'), /CAP_BPF/, 'and says what it would need');
  });

  await it('snapshots the healthy machine exactly once', async () => {
    const s = stubNebius();
    const a = adapter(s);
    const ckpt = await a.boot('node:22');
    assert.equal(ckpt, 'ckpt_1');
    assert.equal(s.seen.filter((r) => r.path.endsWith('/checkpoint')).length, 1);
  });

  await it('every twin forks from the one checkpoint', async () => {
    const s = stubNebius();
    const a = adapter(s);
    await a.fork('ckpt_1', 4);
    const forks = s.seen.filter((r) => r.path === '/fork');
    assert.equal(forks.length, 4);
    assert.deepEqual([...new Set(forks.map((f) => f.body.checkpoint_id))], ['ckpt_1']);
  });

  await it('watches the import step, not the install step', async () => {
    const s = stubNebius();
    const a = adapter(s);
    const [b] = await a.fork('ckpt_1', 1);
    await a.run(b, 'npm install x', { step: 'install', strategy: 'ebpf' });
    await a.run(b, 'node -e require("x")', { step: 'import', strategy: 'ebpf' });
    const execs = s.seen.filter((r) => r.path.endsWith('/exec'));
    assert.equal(execs[0].body.watch, undefined, 'paid to trace an install we do not read');
    assert.equal(execs[1].body.watch.strategy, 'ebpf');
  });

  await it('a missing trace is null, never an empty one', async () => {
    const a = adapter(stubNebius()); // the stub returns trace: null
    const [b] = await a.fork('ckpt_1', 1);
    const r = await a.run(b, 'node -e 0', { step: 'import' });
    assert.equal(r.observed, null, 'an unwatched run must not look like a silent one');
  });

  await it('an empty trace is an empty transcript, not a missing one', async () => {
    const s = stubNebius();
    s.fetchImpl = async (url, opts) => {
      if (url.endsWith('/exec')) return { ok: true, json: async () => ({ exit_code: 0, trace: {} }), text: async () => '' };
      return { ok: true, json: async () => ({ id: 'br_0' }), text: async () => '' };
    };
    const a = adapter(s);
    const [b] = await a.fork('ckpt_1', 1);
    const r = await a.run(b, 'node -e 0', { step: 'import' });
    assert.deepEqual(r.observed, { net: [], dns: [], fs: [], env: [], proc: [], exec: [] });
  });

  await it('translates whatever the sandbox calls things into the schema', async () => {
    const t = normaliseTrace({
      connections: [{ dest: 'evil.example', port: 443 }],
      dns: [{ name: 'evil.example' }],
      files: [{ path: '/tmp/x' }],
      env_read: ['NPM_TOKEN'],
      processes: [{ cmd: 'sh' }],
    });
    assert.deepEqual(t.net, [{ host: 'evil.example', port: 443, proto: 'tcp' }]);
    assert.deepEqual(t.dns, ['evil.example']);
    assert.deepEqual(t.fs, [{ op: 'write', path: '/tmp/x' }]);
    assert.deepEqual(t.proc, [{ argv: ['sh'] }]);
  });

  await it('will not run in a branch it already gave back', async () => {
    const a = adapter(stubNebius());
    const [b] = await a.fork('ckpt_1', 1);
    await a.discard(b);
    assert.equal(a.open, 0);
    await assert.rejects(() => a.run(b, 'x', {}), /discarded/);
  });

  await it('a failed delete still frees the slot — machines are not leaked over a 500', async () => {
    const s = stubNebius();
    const base = s.fetchImpl;
    s.fetchImpl = async (url, opts) =>
      opts.method === 'DELETE' ? { ok: false, status: 500, text: async () => 'boom' } : base(url, opts);
    const a = adapter(s);
    const [b] = await a.fork('ckpt_1', 1);
    await a.discard(b);
    assert.equal(a.open, 0);
  });

  await it('an API failure says which call failed and what came back', async () => {
    const s = stubNebius();
    s.fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'too many sandboxes' });
    await assert.rejects(() => adapter(s).boot('node:22'), /429.*too many sandboxes/);
  });

  console.log(`\n${passed} passed`);
})();
