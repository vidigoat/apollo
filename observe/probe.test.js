/**
 * The runtime probe.
 *
 * This is the only observer in the project that has actually watched anything, so everything the
 * `nodert` strategy claims rests here. Tested against packages written for the purpose — one that
 * misbehaves in every channel, one that does nothing, one that dies, and one that lies.
 *
 * No network and no registry: fixtures are written to a temp directory and required by path.
 *
 * Run: node observe/probe.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runnerSource, readReport } = require('./probe');

let passed = 0;
const it = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n       ', e.message);
    process.exitCode = 1;
  }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Write a fake package and run it under the probe, exactly as the local adapter does. */
function watch(name, source) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  const out = path.join(ROOT, `${name}.json`);
  const runner = path.join(ROOT, `run-${name}.js`);
  fs.writeFileSync(runner, runnerSource(path.join(dir, 'index.js'), out));
  try {
    execFileSync(process.execPath, [runner], { cwd: ROOT, stdio: 'pipe', timeout: 20_000 });
  } catch { /* the package may exit non-zero; the report is what we came for */ }
  return readReport(out);
}

console.log('runtime probe');

it('sees a credential being read', () => {
  const r = watch('creds', `process.env.AWS_SECRET_ACCESS_KEY; process.env.NPM_TOKEN;`);
  assert.ok(r, 'no report at all');
  assert.ok(r.env.includes('AWS_SECRET_ACCESS_KEY'), `env was ${JSON.stringify(r.env)}`);
  assert.ok(r.env.includes('NPM_TOKEN'));
});

it('sees a socket being opened, and to where', () => {
  // Nothing is listening; the connection attempt is what we are watching for, not its success.
  const r = watch('net', `
    const net = require('node:net');
    const s = new net.Socket();
    s.on('error', () => {});
    s.connect(59999, '127.0.0.1');
  `);
  assert.ok(r.net.some((n) => n.host === '127.0.0.1' && n.port === 59999), JSON.stringify(r.net));
});

it('sees a name being resolved', () => {
  const r = watch('dns', `require('node:dns').lookup('example.invalid', () => {});`);
  assert.ok(r.dns.includes('example.invalid'), JSON.stringify(r.dns));
});

it('sees a process being spawned, with its arguments', () => {
  const r = watch('proc', `
    try { require('node:child_process').spawnSync('/bin/echo', ['hello']); } catch {}
  `);
  assert.ok(r.proc.some((p) => p.argv.join(' ').includes('/bin/echo hello')), JSON.stringify(r.proc));
});

it('sees a file being written', () => {
  const r = watch('fsw', `
    try { require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(ROOT)}, 'dropped.txt'), 'x'); } catch {}
  `);
  assert.ok(r.fs.some((f) => f.op === 'write' && f.path.endsWith('dropped.txt')), JSON.stringify(r.fs));
});

it('a package that does nothing produces an empty report, not a missing one', () => {
  const r = watch('quiet', `module.exports = 1;`);
  assert.ok(r, 'a quiet package must still report');
  assert.deepEqual(r, { net: [], dns: [], fs: [], env: [], proc: [], exec: [] });
});

it('a package that throws on import still reports what it did first', () => {
  const r = watch('throws', `process.env.NPM_TOKEN; throw new Error('boom');`);
  assert.ok(r, 'the report was lost because the package threw');
  assert.ok(r.env.includes('NPM_TOKEN'), 'it read a credential before dying, and that is the finding');
});

it('a package that kills the process leaves no report — and that is not "nothing"', () => {
  const r = watch('suicide', `process.env.NPM_TOKEN; process.exit(0);`);
  assert.equal(r, null, 'an unreported run must never look like a quiet one');
});

it('a forged report is refused rather than believed', () => {
  // A hostile package shares our heap, so it can reach the file. It must not be able to hand us
  // something that merely looks right — see docs/decisions/005 and probe.js on why a file is a
  // mitigation, not containment.
  const out = path.join(ROOT, 'forged.json');
  for (const junk of ['not json', '[]', 'null', '{"net":"none"}', '{"net":[],"dns":[]}', '"clean"']) {
    fs.writeFileSync(out, junk);
    assert.equal(readReport(out), null, `accepted a forged report: ${junk}`);
  }
  fs.writeFileSync(out, JSON.stringify({ net: [], dns: [], fs: [], env: [], proc: [], exec: [], extra: 'ignored' }));
  assert.deepEqual(readReport(out), { net: [], dns: [], fs: [], env: [], proc: [], exec: [] },
    'a valid report with extra keys should be accepted, with the extras dropped');
});

it('a report that was never written reads as missing', () => {
  assert.equal(readReport(path.join(ROOT, 'never-existed.json')), null);
});

it('the probe does not leak the value of anything it watched', () => {
  const r = watch('leak', `process.env.PATH; process.env.HOME;`);
  const serialised = JSON.stringify(r);
  assert.ok(r.env.includes('PATH'), 'the read must be recorded');
  assert.ok(!serialised.includes(process.env.HOME), 'the VALUE of an environment variable escaped');
});

it('watching a package does not change what it computes', () => {
  const r = watch('behaviour', `
    const fsx = require('node:fs');
    const v = process.env.HOME;
    fsx.writeFileSync(require('node:path').join(${JSON.stringify(ROOT)}, 'proof.txt'), String(v || 'none'));
  `);
  assert.ok(r.env.includes('HOME'));
  assert.equal(fs.readFileSync(path.join(ROOT, 'proof.txt'), 'utf8'), String(process.env.HOME || 'none'),
    'the proxy changed the value the package received');
});

it('sees a string turn into a function', () => {
  // The one thing this strategy catches that a kernel tracer cannot. Nothing below is a syscall.
  const r = watch('built', `
    const payload = Buffer.from("${'Y29uc29sZS5sb2coMSk7'.repeat(12)}", "base64").toString();
    const f = new Function("x", "return x + 1");
    f(1);
  `);
  assert.ok(r, 'no report');
  const hows = r.exec.map((e) => e.how);
  assert.ok(hows.includes('Function'), `expected a Function entry, got ${JSON.stringify(hows)}`);
  assert.ok(hows.includes('base64-decode'), 'the decode that fed it was not recorded');
});

it('sees code run through vm', () => {
  const r = watch('vm', `require('node:vm').runInNewContext('1 + 1');`);
  assert.ok(r.exec.some((e) => e.how === 'vm.runInNewContext'), JSON.stringify(r.exec));
});

it('records an excerpt, never the whole payload', () => {
  const r = watch('huge', `new Function("x", "/*" + "A".repeat(500000) + "*/ return x");`);
  const entry = r.exec.find((e) => e.how === 'Function');
  assert.ok(entry, 'missed it entirely');
  assert.ok(entry.sample.length <= 160,
    `kept ${entry.sample.length} characters — a megabyte of obfuscated source is volume, not evidence`);
});

it('an ordinary package builds no code at all', () => {
  const r = watch('plain', `module.exports = { add: (a, b) => a + b };`);
  assert.deepEqual(r.exec, [], 'something ordinary was recorded as building code');
});

it('a read Node makes while loading the package is Node\'s, not the package\'s', () => {
  // A file with a source map makes Node read NODE_V8_COVERAGE (maybeCacheSourceMap); util.debuglog
  // makes it read NODE_DEBUG. Neither is the package asking — only the direct read below is.
  const r = watch('runtime-reads', [
    "require('node:util').debuglog('stakeout-test')('x');",
    'process.env.STAKEOUT_DIRECT_READ;',
    'module.exports = 1;',
    '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbXSwibWFwcGluZ3MiOiIifQ==',
  ].join('\n'));
  assert.ok(r.env.includes('STAKEOUT_DIRECT_READ'), `a direct read was missed: ${JSON.stringify(r.env)}`);
  assert.ok(!r.env.includes('NODE_V8_COVERAGE'), `Node's source-map read was credited to the package: ${JSON.stringify(r.env)}`);
  assert.ok(!r.env.includes('NODE_DEBUG'), `Node's debuglog read was credited to the package: ${JSON.stringify(r.env)}`);
});

console.log(`\n${passed} passed`);
