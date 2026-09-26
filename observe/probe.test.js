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
function watch(name, source, env) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  const out = path.join(ROOT, `${name}.json`);
  const runner = path.join(ROOT, `run-${name}.js`);
  fs.writeFileSync(runner, runnerSource(path.join(dir, 'index.js'), out));
  try {
    execFileSync(process.execPath, [runner], { cwd: ROOT, stdio: 'pipe', timeout: 20_000, env: env ? { ...process.env, ...env } : process.env });
  } catch { /* the package may exit non-zero; the report is what we came for */ }
  return readReport(out);
}

/** Where the npm running these tests really lives, as the adapters pass it. */
function npmRoot() {
  const bin = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return path.join(bin, 'npm');
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

it('sees where net.connect and a plain http request go — not "localhost", port null', () => {
  // Both hand Socket#connect Node's internal normalised array, not an options object. Read as an
  // object it had no host and no port, so every such connection was recorded as localhost:null —
  // and the differ keys connections by host and port, so a new destination merged into the old key.
  const r = watch('net-common', `
    const net = require('node:net');
    net.connect(59998, '127.0.0.1').on('error', () => {});
    require('node:http').request({ host: '127.0.0.1', port: 59997, path: '/' }).on('error', () => {}).end();
  `);
  assert.ok(r.net.some((n) => n.host === '127.0.0.1' && n.port === 59998), JSON.stringify(r.net));
  assert.ok(r.net.some((n) => n.host === '127.0.0.1' && n.port === 59997), JSON.stringify(r.net));
  assert.ok(!r.net.some((n) => n.port === null), `a connection lost its port: ${JSON.stringify(r.net)}`);
});

it('watches what an install script does — and leaves out npm itself', () => {
  // A local fixture, installed from its folder: nothing leaves the machine and no stranger's code
  // runs. Its postinstall reads a credential-shaped variable, opens a socket and starts a shell.
  const pkg = path.join(ROOT, 'fixture-pkg');
  const twin = path.join(ROOT, 'fixture-twin');
  const inst = path.join(ROOT, 'fixture-install');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(twin, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'stakeout-fixture', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node post.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(pkg, 'post.js'), "process.env.NPM_TOKEN; require('node:net').connect(59996, '127.0.0.1').on('error', () => {}); require('node:child_process').spawnSync('sh', ['-c', 'true']);");
  fs.writeFileSync(path.join(twin, 'package.json'), '{"name":"twin","version":"1.0.0"}');
  execFileSync('npm', ['install', pkg, '--no-audit', '--no-fund', '--loglevel=error', '--offline'], {
    cwd: twin, stdio: 'pipe', timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: `--require ${require.resolve('./probe')}`, STAKEOUT_INSTALL_DIR: inst, STAKEOUT_NPM_ROOT: npmRoot() },
  });
  const out = path.join(ROOT, 'fixture.json');
  const runner = path.join(twin, 'run.js');
  fs.writeFileSync(runner, runnerSource('stakeout-fixture', out, require.resolve('./probe'), inst));
  execFileSync(process.execPath, [runner], { cwd: twin, stdio: 'pipe', timeout: 20_000 });
  const r = readReport(out);
  assert.ok(r.install, 'the install phase was not reported');
  assert.ok(r.install.env.includes('NPM_TOKEN'), `install env: ${JSON.stringify(r.install.env)}`);
  assert.ok(r.install.net.some((n) => n.host === '127.0.0.1' && n.port === 59996), JSON.stringify(r.install.net));
  assert.ok(r.install.proc.some((x) => x.argv.join(' ') === 'sh -c node post.js'), 'npm did not record the script it ran');
  assert.ok(r.install.proc.some((x) => x.argv.join(' ') === 'sh -c true'), 'the script\'s own child was not seen');
  assert.ok(!r.install.env.some((v) => /^npm_config_/.test(v)), `npm's own config reads leaked in: ${r.install.env.filter((v) => /^npm_/.test(v)).slice(0, 5)}`);
  assert.deepEqual(r.env, [], 'the install phase leaked into the import channels');
});

it('an install script cannot pass for npm by calling itself npm-cli.js', () => {
  // npm is watched only for what it starts, so being mistaken for npm would hide a script's network
  // and environment reads. The name is not enough; the real path has to be the npm that ran.
  const pkg = path.join(ROOT, 'disguise-pkg');
  const twin = path.join(ROOT, 'disguise-twin');
  const inst = path.join(ROOT, 'disguise-install');
  fs.mkdirSync(path.join(pkg, 'node_modules', 'npm'), { recursive: true });
  fs.mkdirSync(twin, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'disguise', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node npm-cli.js && node node_modules/npm/x.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 1;');
  const payload = "process.env.NPM_TOKEN; require('node:net').connect(59995, '127.0.0.1').on('error', () => {});";
  fs.writeFileSync(path.join(pkg, 'npm-cli.js'), payload);
  fs.writeFileSync(path.join(pkg, 'node_modules', 'npm', 'x.js'), payload);
  fs.writeFileSync(path.join(twin, 'package.json'), '{"name":"twin","version":"1.0.0"}');
  execFileSync('npm', ['install', pkg, '--no-audit', '--no-fund', '--loglevel=error', '--offline'], {
    cwd: twin, stdio: 'pipe', timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: `--require ${require.resolve('./probe')}`, STAKEOUT_INSTALL_DIR: inst, STAKEOUT_NPM_ROOT: npmRoot() },
  });
  const out = path.join(ROOT, 'disguise.json');
  const runner = path.join(twin, 'run.js');
  fs.writeFileSync(runner, runnerSource('disguise', out, require.resolve('./probe'), inst));
  execFileSync(process.execPath, [runner], { cwd: twin, stdio: 'pipe', timeout: 20_000 });
  const r = readReport(out);
  assert.ok(r.install.env.includes('NPM_TOKEN'), `a disguised script's reads were hidden: ${JSON.stringify(r.install.env)}`);
  assert.ok(r.install.net.some((n) => n.port === 59995), 'a disguised script\'s connection was hidden');
});

it('an install phase nobody reported on is absent, not an install that ran nothing', () => {
  const out = path.join(ROOT, 'no-install.json');
  const dir = path.join(ROOT, 'no-install-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), '1;');
  const runner = path.join(ROOT, 'run-no-install.js');
  fs.writeFileSync(runner, runnerSource(path.join(dir, 'index.js'), out, require.resolve('./probe'), path.join(ROOT, 'empty-install-dir')));
  execFileSync(process.execPath, [runner], { cwd: ROOT, stdio: 'pipe', timeout: 20_000 });
  assert.equal(readReport(out).install, undefined);
});

it('a decode Node makes while loading node:http is Node\'s, not the package\'s', () => {
  // agent-base@9.0.0 contains no base64 at all, and the old probe credited it with decoding 64,860
  // characters: Node decodes its bundled HTTP parser the first time node:http loads. The package here is ESM
  // and decodes nothing; loading node:http makes Node decode its bundled HTTP parser, 64,860 chars.
  const dir = path.join(ROOT, 'esm-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-pkg', version: '1.0.0', type: 'module', exports: { default: './index.js' } }));
  fs.writeFileSync(path.join(dir, 'index.js'), "import http from 'node:http'; export const x = typeof http;");
  const out = path.join(ROOT, 'esm.json');
  const runner = path.join(ROOT, 'run-esm.js');
  fs.writeFileSync(runner, runnerSource(dir, out));
  execFileSync(process.execPath, [runner], { cwd: ROOT, stdio: 'pipe', timeout: 20_000 });
  const r = readReport(out);
  assert.deepEqual(r.exec, [], `Node's own work was credited to the package: ${JSON.stringify(r.exec)}`);
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
  assert.deepEqual(r, { net: [], dns: [], fs: [], env: [], proc: [], exec: [], contained: false });
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

it('contained mode records a connection and a decoy on the wire, and never forwards it', () => {
  // No live listener here (a synchronous child would deadlock one); that a contained run reaches
  // nothing is measured in scripts/interrogate.js --demo. This pins the recording and the flag.
  const r = watch('contained-egress', [
    `const http = require('node:http');`,
    `const req = http.request({ host: '127.0.0.1', port: 59999, method: 'POST', path: '/x' });`,
    `req.on('error', () => {});`,
    `req.end('stolen=' + process.env.LOOT);`,
    `module.exports = 1;`,
  ].join('\n'), { STAKEOUT_CONTAINED: '1', STAKEOUT_CANARY: 'DECOY-MARK', LOOT: 'DECOY-MARK-secret' });
  assert.ok(r, 'no report');
  assert.equal(r.contained, true);
  assert.ok(r.net.some((n) => n && n.host === '127.0.0.1'), 'the connection attempt was not recorded');
  assert.ok(r.net.some((n) => n && n.exfil), 'the decoy on the wire was not caught');
});

it('outside contained mode a run is not decoy-scanned and is not marked contained', () => {
  const r = watch('normal-nocontain', [
    `try { require('node:dns').lookup('localhost', () => {}); } catch {}`,
    `module.exports = 1;`,
  ].join('\n'));
  assert.equal(r.contained, false);
  assert.ok(!r.net.some((n) => n && n.exfil), 'a normal run was scanned for a decoy it was never given');
});

it('contained mode really blocks egress: a live listener gets nothing', () => {
  // Measured against a real listener, in a single child so its event loop can accept while it
  // connects (a synchronous child spawned from here could not). The child prints the hit count and
  // what the probe recorded; egress blocked means the listener was never touched.
  const child = `
    const http = require('node:http');
    const { install } = require(${JSON.stringify(path.join(__dirname, 'probe.js'))});
    let hits = 0;
    const server = http.createServer((req, res) => { hits++; res.end('ok'); });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const probe = install();
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/x' });
      req.on('error', () => {});
      req.end('loot=EGRESS-CANARY');
      setTimeout(() => { server.close(); console.log(JSON.stringify({ hits, net: probe.seen.net, contained: probe.seen.contained })); process.exit(0); }, 250);
    });`;
  const out = execFileSync(process.execPath, ['-e', child], { encoding: 'utf8', env: { ...process.env, STAKEOUT_CONTAINED: '1', STAKEOUT_CANARY: 'EGRESS-CANARY' }, timeout: 10000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.hits, 0, 'a contained run reached the listener — a byte left the box');
  assert.equal(r.contained, true);
  assert.ok(r.net.some((n) => n && n.host === '127.0.0.1'), 'the blocked attempt was not recorded');
  assert.ok(r.net.some((n) => n && n.exfil), 'the decoy was not caught on the wire');
});

console.log(`\n${passed} passed`);
