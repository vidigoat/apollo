/**
 * The command line — and specifically, its exit codes.
 *
 *   node cli.test.js
 *
 * `stakeout check` runs in CI, where nobody reads the output until something fails. **The exit code
 * IS the product.** Everything else on screen is a courtesy to whoever eventually opens the log.
 *
 *   0   clean
 *   1   drift — a package now behaves differently than the lock records
 *   2   unknown, and --fail-on-unknown was set
 *   3   usage or environment error
 *
 * 3 exists so that a broken run and a real finding never look the same to a pipeline. A tool that
 * exits 1 when it cannot find its own config is a tool that teaches people to ignore exit 1 — and
 * then the one time it means something, nobody looks.
 *
 * Everything runs through a child process, because `main()` returning the right number is not the
 * claim. The claim is that `stakeout check` in a shell exits with it.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Index } = require('./index/schema');

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

const CLI = path.join(__dirname, 'cli.js');

/** Run the CLI as a shell would, and report what the shell would see. */
function run(args, { env = {}, cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const transcript = (version, over = {}) => ({
  pkg: 'p', version, strategy: 'nodert',
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  ...over,
});

/** A throwaway project: its own index, its own lockfile, its own working directory. */
function project(packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stakeout-cli-'));
  const indexDir = path.join(root, 'index');
  const index = new Index({ dir: indexDir });

  const lockPackages = {};
  for (const [name, version, over] of packages) {
    index.put(name, transcript(version, over));
    lockPackages[`node_modules/${name}`] = { version };
  }
  index.writeManifest({ revision: 'test' });

  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...lockPackages } })
  );
  return { root, indexDir, index };
}

const withIndex = (dir) => ({ STAKEOUT_INDEX: dir });

console.log('cli — exit codes are the interface');

it('no arguments prints usage and exits 3', () => {
  // Not 0: a CI step that invokes it wrongly must fail, not silently succeed.
  const r = run([]);
  assert.equal(r.code, 3);
  assert.match(r.out, /pins behaviour/);
});

it('an unknown command exits 3', () => {
  assert.equal(run(['frobnicate']).code, 3);
});

it('`help` is a successful command, not an error', () => {
  const r = run(['help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /stakeout lock/);
});

it('with no index, every command exits 3 and says what to do', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-index-'));
  for (const cmd of [['lock'], ['check'], ['explain', 'lodash']]) {
    const r = run(cmd, { env: withIndex(empty) });
    assert.equal(r.code, 3, `${cmd[0]} did not exit 3`);
    assert.match(r.out, /index/i);
  }
});

it('lock writes a lock and exits 0', () => {
  const p = project([['alpha', '1.0.0'], ['beta', '2.0.0', { env: ['CI'] }]]);
  const out = path.join(p.root, 'stakeout.lock');
  const r = run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(out), 'no lock was written');
  const lock = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['alpha@1.0.0', 'beta@2.0.0']);
});

it('--dry-run writes nothing', () => {
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'stakeout.lock');
  const r = run(['lock', '--out', out, '--dry-run'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(out), false, 'a dry run wrote a file');
});

it('check exits 0 when nothing has drifted', () => {
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'stakeout.lock');
  run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  const r = run(['check', '--lock', out], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.match(r.out, /clean|no drift/);
});

it('check exits 1 when a pinned version starts doing something new', () => {
  // The whole point of the file. The version did not move; the behaviour did.
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'stakeout.lock');
  run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  p.index.put('alpha', transcript('1.0.0', { env: ['AWS_SECRET_ACCESS_KEY'] }));
  p.index.writeManifest({ revision: 'test' });

  const r = run(['check', '--lock', out], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 1, 'drift did not fail the build');
  assert.match(r.out, /AWS_SECRET_ACCESS_KEY/, 'the finding was not shown');
});

it('check exits 2 for unknowns only when asked to', () => {
  /*
   * Unknown is not failure by default, because on a real tree most packages start unknown and a
   * tool that red-lights on day one gets removed before it ever finds anything. It becomes failure
   * when a project has decided its index should be complete — and then it is a different code from
   * drift, so the pipeline can tell "I found something" from "I could not look".
   */
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'stakeout.lock');
  run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  // A dependency the index has never observed appears in the tree.
  const lockfile = path.join(p.root, 'package-lock.json');
  const tree = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  tree.packages['node_modules/ghost'] = { version: '9.9.9' };
  fs.writeFileSync(lockfile, JSON.stringify(tree));

  const lenient = run(['check', '--lock', out], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(lenient.code, 0, 'unknown failed the build without being asked to');
  assert.match(lenient.out, /never seen/);

  const strict = run(['check', '--lock', out, '--fail-on-unknown'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(strict.code, 2, '--fail-on-unknown did not produce its own exit code');
});

it('check with no lock exits 3, not 1', () => {
  // "You have not run lock yet" is an environment problem, not a finding.
  const p = project([['alpha', '1.0.0']]);
  const r = run(['check', '--lock', path.join(p.root, 'nope.lock')], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 3);
  assert.match(r.out, /stakeout lock/);
});

it('explain shows what a package did, and who was watching', () => {
  const p = project([['alpha', '1.0.0', { env: ['CI', 'NO_COLOR'] }]]);
  const r = run(['explain', 'alpha'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.match(r.out, /NO_COLOR/);
  assert.match(r.out, /nodert/, 'the strategy was not named');
});

it('explain is honest about a package it has never seen', () => {
  const p = project([['alpha', '1.0.0']]);
  const r = run(['explain', 'ghost'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0, 'not knowing is not an error');
  assert.match(r.out, /absence of evidence/i, 'it implied the package does nothing');
});

it('explain names a blind spot rather than reporting quiet', () => {
  const blind = transcript('1.0.0', {
    strategy: 'fsdiff',
    canSee: { net: false, dns: false, fs: true, env: false, proc: false, exec: false },
  });
  for (const c of ['net', 'dns', 'env', 'proc', 'exec']) delete blind[c];

  const p = project([]);
  p.index.put('alpha', blind);
  p.index.writeManifest({ revision: 'test' });

  const r = run(['explain', 'alpha@1.0.0'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.match(r.out, /cannot see/, 'a blind run reported as quiet');
  assert.match(r.out, /silence there means nothing/);
});

it('index prints what it holds', () => {
  const p = project([['alpha', '1.0.0'], ['beta', '2.0.0']]);
  const r = run(['index'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.match(r.out, /packages\s+2/);
  assert.match(r.out, /nodert/);
});

console.log(`\n${passed} passed`);
