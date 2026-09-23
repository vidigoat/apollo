/**
 * Watching one package in one machine.
 *
 * Small module, three claims worth holding down:
 *
 *   1. We install AND import. Since npm 12 disabled install scripts by default, a tool that only
 *      watches `npm install` watches the door the attackers stopped using.
 *   2. We ask for the best strategy the adapter admits to, and the transcript records which one
 *      actually ran — never the one we hoped for.
 *   3. Observation from every step accumulates, and a step that observed nothing contributes
 *      nothing rather than erasing what came before.
 *
 * Run: node observe/observe.test.js
 */

const assert = require('node:assert');
const { observePackage, commandsFor, bestStrategy } = require('./index');
const { CAN_SEE } = require('../transcript/schema');

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

/** An adapter that records what it was asked and replies with whatever the test supplies. */
function recorder(reply = () => ({ code: 0, stdout: '', observed: null })) {
  const calls = [];
  return {
    calls,
    supports: ['ebpf', 'proxy', 'fsdiff'],
    async run(branch, cmd, ctx) {
      calls.push({ cmd, ctx });
      return reply(ctx, cmd);
    },
  };
}

const labels = (strategy) => commandsFor({ pkg: 'p', version: '1', strategy }).map((s) => s.label);

(async () => {
  console.log('observation');

  await it('every strategy installs and then imports, in that order', () => {
    for (const s of ['ebpf', 'proxy', 'fsdiff']) {
      const l = labels(s);
      assert.ok(l.includes('install'), `${s} never installs`);
      assert.ok(l.includes('import'), `${s} never imports — that is where 2026's attacks fire`);
      assert.ok(l.indexOf('install') < l.indexOf('import'), `${s} imports before installing`);
    }
  });

  await it('the import runs the package, and the install does not skip its scripts', () => {
    const steps = commandsFor({ pkg: 'left-pad', version: '1.3.0', strategy: 'ebpf' });
    const install = steps.find((s) => s.label === 'install').cmd;
    const imp = steps.find((s) => s.label === 'import').cmd;
    assert.match(install, /left-pad@1\.3\.0/);
    assert.match(install, /--ignore-scripts=false/, 'skipping scripts would hide the older attack class');
    assert.match(imp, /require\('left-pad'\)/);
  });

  await it('the watching strategies collect something and the cheap one does not need to', () => {
    assert.ok(labels('ebpf').includes('collect'));
    assert.ok(labels('proxy').includes('collect'));
    assert.ok(!labels('fsdiff').includes('collect'),
      'fsdiff reads the checkpoint delta — a collect step would be a command that does nothing');
  });

  await it('an unknown strategy falls back to the cheapest rather than producing no commands', () => {
    assert.deepEqual(labels('telepathy'), labels('fsdiff'));
  });

  await it('asks for the best strategy the adapter admits to', () => {
    assert.equal(bestStrategy({ supports: ['ebpf', 'proxy', 'fsdiff'] }), 'ebpf');
    assert.equal(bestStrategy({ supports: ['proxy', 'fsdiff'] }), 'proxy');
    assert.equal(bestStrategy({ supports: ['fsdiff'] }), 'fsdiff');
    assert.equal(bestStrategy({}), 'fsdiff', 'an adapter that says nothing gets the weakest assumption');
    assert.equal(bestStrategy({ supports: ['telepathy'] }), 'fsdiff', 'never trust a strategy we cannot run');
  });

  await it('a nodert run whose probe never reported, or that never installed, is not an observation', async () => {
    const { unobserved } = require('../transcript/schema');
    const adapter = (installCode, observed) => ({
      run: async (_b, _cmd, ctx) => (ctx.step === 'install' ? { code: installCode } : { code: 0, observed }),
    });
    const seen = await observePackage({ adapter: adapter(0, { env: ['NO_COLOR'] }), branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'nodert' });
    assert.equal(unobserved(seen), null);
    const silent = await observePackage({ adapter: adapter(0, null), branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'nodert' });
    assert.match(unobserved(silent), /never reported/);
    assert.deepEqual(silent.env, [], 'the channels are empty, which is exactly why they cannot be trusted alone');
    const broken = await observePackage({ adapter: adapter(1, null), branch: { id: 'b' }, pkg: 'utf-8-validate', version: '5.0.10', strategy: 'nodert' });
    assert.match(unobserved(broken), /did not install \(npm exited 1\)/);
    const platform = await observePackage({
      adapter: { run: async (_b, _c, ctx) => (ctx.step === 'install' ? { code: 1, stderr: 'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform' } : { code: 0, observed: null }) },
      branch: { id: 'b' }, pkg: '@esbuild/darwin-arm64', version: '0.28.1', strategy: 'nodert',
    });
    assert.match(unobserved(platform), /npm exited 1, EBADPLATFORM/);
  });

  await it('the transcript records the strategy that ran, and what it could not see', async () => {
    const t = await observePackage({ adapter: recorder(), branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'fsdiff' });
    assert.equal(t.strategy, 'fsdiff');
    assert.deepEqual(t.canSee, CAN_SEE.fsdiff);
    assert.equal(t.canSee.net, false, 'a filesystem-only run must not imply it watched the network');
  });

  await it('every step is told which package and which step it is', async () => {
    const a = recorder();
    await observePackage({ adapter: a, branch: { id: 'b' }, pkg: 'p', version: '2', strategy: 'ebpf' });
    a.calls.forEach((c) => {
      assert.equal(c.ctx.pkg, 'p');
      assert.equal(c.ctx.version, '2');
      assert.equal(c.ctx.strategy, 'ebpf');
      assert.ok(c.ctx.step, 'a step without a label cannot be attributed');
    });
  });

  await it('observation from several steps accumulates', async () => {
    const a = recorder((ctx) => ({
      code: 0,
      observed: ctx.step === 'import'
        ? { net: [{ host: 'a.example', port: 443 }], env: ['NPM_TOKEN'] }
        : ctx.step === 'collect'
          ? { proc: [{ argv: ['sh', '-c', 'x'] }] }
          : null,
    }));
    const t = await observePackage({ adapter: a, branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'ebpf' });
    assert.equal(t.net.length, 1);
    assert.deepEqual(t.env, ['NPM_TOKEN']);
    assert.equal(t.proc.length, 1, 'the collect step\'s findings were dropped');
  });

  await it('a step that observed nothing erases nothing', async () => {
    const a = recorder((ctx) => ({
      code: 0,
      observed: ctx.step === 'import' ? { net: [{ host: 'a.example', port: 443 }] } : null,
    }));
    const t = await observePackage({ adapter: a, branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'ebpf' });
    assert.equal(t.net.length, 1, 'a later unobserved step overwrote an earlier finding');
  });

  await it('a package that throws on import is recorded as having thrown', async () => {
    const ok = recorder();
    const bad = recorder((ctx) => ({ code: ctx.step === 'import' ? 1 : 0, observed: null }));

    const good = await observePackage({ adapter: ok, branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'fsdiff' });
    assert.equal(good.result.threw, false);
    assert.equal(good.result.importExit, 0);

    const t = await observePackage({ adapter: bad, branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'fsdiff' });
    assert.equal(t.result.threw, true);
    assert.equal(t.result.importExit, 1);
  });

  await it('install and import are timed separately', async () => {
    const t = await observePackage({ adapter: recorder(), branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'fsdiff' });
    assert.equal(typeof t.timing.installMs, 'number');
    assert.equal(typeof t.timing.importMs, 'number');
  });

  await it('an adapter failure surfaces instead of becoming an empty transcript', async () => {
    const a = { supports: ['fsdiff'], run: async () => { throw new Error('branch died'); } };
    await assert.rejects(
      () => observePackage({ adapter: a, branch: { id: 'b' }, pkg: 'p', version: '1', strategy: 'fsdiff' }),
      /branch died/,
      'a dead machine reported as a quiet package is the worst possible failure here'
    );
  });

  console.log(`\n${passed} passed`);
})();
