/**
 * The local adapter.
 *
 * This is the one that actually executes third-party code, so the things worth holding down are
 * not about features. They are: it refuses to run unless somebody meant it, twins are genuinely
 * independent copies, nothing is left on disk afterwards, and it never reports silence it did not
 * observe.
 *
 * No network: the install step is not exercised here (scripts/real.js does that against the real
 * registry). Everything else is.
 *
 * Run: node adapters/local.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalMachines } = require('./local');
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

const allow = (on) => {
  if (on) process.env.STAKEOUT_ALLOW_LOCAL = '1';
  else delete process.env.STAKEOUT_ALLOW_LOCAL;
};

(async () => {
  console.log('local adapter');

  await it('refuses to exist unless somebody meant it', () => {
    allow(false);
    assert.throws(() => new LocalMachines(), /STAKEOUT_ALLOW_LOCAL/);
    assert.throws(() => new LocalMachines(), /Nothing isolates them/,
      'the refusal has to say why, not just how to bypass it');
    allow(true);
    const m = new LocalMachines();
    m.cleanup();
  });

  await it('claims only the runtime probe, never syscalls', () => {
    allow(true);
    const m = new LocalMachines();
    assert.deepEqual(m.supports, ['nodert'],
      'claiming eBPF here would turn "we could not see it" into "nothing happened"');
    m.cleanup();
  });

  await it('is interchangeable with the simulated adapter, step for step', async () => {
    allow(true);
    const shapes = [];
    for (const a of [new LocalMachines(), new SimulatedSandboxes()]) {
      const ckpt = await a.boot('node:22');
      const branches = await a.fork(ckpt, 2);
      const r = await a.run(branches[0], 'noop', { step: 'other', pkg: 'x', version: '1' });
      for (const b of branches) await a.discard(b);
      shapes.push({
        checkpoint: typeof ckpt,
        branches: branches.length,
        branchHasId: branches.every((b) => typeof b.id === 'string'),
        runKeys: Object.keys(r).sort().filter((k) => k !== 'stderr').join(','),
        openAfter: a.open,
      });
      a.cleanup?.();
    }
    assert.deepEqual(shapes[0], shapes[1], 'the adapters have drifted');
  });

  await it('twins are real, separate copies — one cannot see the other', async () => {
    allow(true);
    const m = new LocalMachines();
    const ckpt = await m.boot();
    const [a, b] = await m.fork(ckpt, 2);

    assert.notEqual(a.dir, b.dir);
    assert.ok(fs.existsSync(path.join(a.dir, 'package.json')), 'a twin did not get the base state');

    fs.writeFileSync(path.join(a.dir, 'only-in-a.txt'), 'x');
    assert.ok(!fs.existsSync(path.join(b.dir, 'only-in-a.txt')),
      'the twins share a directory, so a difference could be one contaminating the other');

    await m.discard(a);
    await m.discard(b);
    m.cleanup();
  });

  await it('a discarded twin is gone from the disk, not just from the map', async () => {
    allow(true);
    const m = new LocalMachines();
    const [a] = await m.fork(await m.boot(), 1);
    const dir = a.dir;
    await m.discard(a);
    assert.equal(m.open, 0);
    assert.ok(!fs.existsSync(dir), 'the directory outlived the branch');
    await assert.rejects(() => m.run(a, 'x', {}), /discarded/);
    m.cleanup();
  });

  await it('cleanup leaves nothing behind', async () => {
    allow(true);
    const m = new LocalMachines();
    const root = m.root;
    await m.fork(await m.boot(), 3);
    assert.ok(fs.existsSync(root));
    m.cleanup();
    assert.ok(!fs.existsSync(root), 'a run left machines on the disk');
  });

  await it('a step that is not install or import observes nothing and says so', async () => {
    allow(true);
    const m = new LocalMachines();
    const [a] = await m.fork(await m.boot(), 1);
    const r = await m.run(a, 'anything', { step: 'collect' });
    assert.equal(r.observed, null, 'a step we did not watch must report null, not an empty trace');
    m.cleanup();
  });

  await it('a package that never reports reads as unobserved, not as quiet', async () => {
    allow(true);
    const m = new LocalMachines();
    const [a] = await m.fork(await m.boot(), 1);
    // No node_modules, so require() throws and the runner still writes a report...
    const good = await m.run(a, '', { step: 'import', pkg: 'definitely-not-installed' });
    assert.notEqual(good.observed, null, 'a package that threw still reported what it did first');

    // ...but a runner that cannot write at all must produce null.
    const m2 = new LocalMachines();
    const [b] = await m2.fork(await m2.boot(), 1);
    m2.root = path.join(os.tmpdir(), 'stakeout-nowhere', 'nope'); // report path becomes unwritable
    const bad = await m2.run(b, '', { step: 'import', pkg: 'definitely-not-installed' });
    assert.equal(bad.observed, null, 'a lost report must never look like a silent package');

    m.cleanup();
    fs.rmSync(b.dir, { recursive: true, force: true });
  });

  await it('a non-zero exit is a result, not an exception', async () => {
    allow(true);
    const m = new LocalMachines();
    const [a] = await m.fork(await m.boot(), 1);
    const r = await m.sh(process.execPath, ['-e', 'process.exit(3)'], a.dir);
    assert.equal(r.code, 3, 'a package that fails to install is a fact about that version');
    m.cleanup();
  });

  await it('a missing binary is an exception, because it is our problem not the package\'s', async () => {
    allow(true);
    const m = new LocalMachines();
    const [a] = await m.fork(await m.boot(), 1);
    await assert.rejects(() => m.sh('definitely-not-a-real-binary-xyz', [], a.dir), /not on PATH/);
    m.cleanup();
  });

  console.log(`\n${passed} passed`);
})();
