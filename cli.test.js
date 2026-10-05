/**
 * The command line — and specifically, its exit codes.
 *
 *   node cli.test.js
 *
 * `apollo check` runs in CI, where nobody reads the output until something fails. **The exit code
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
 * claim. The claim is that `apollo check` in a shell exits with it.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cli-'));
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

const withIndex = (dir) => ({ APOLLO_INDEX: dir });

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
  assert.match(r.out, /apollo lock/);
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
  const out = path.join(p.root, 'apollo.lock');
  const r = run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(out), 'no lock was written');
  const lock = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['alpha@1.0.0', 'beta@2.0.0']);
});

it('--dry-run writes nothing', () => {
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'apollo.lock');
  const r = run(['lock', '--out', out, '--dry-run'], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(out), false, 'a dry run wrote a file');
});

it('check exits 0 when nothing has drifted', () => {
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'apollo.lock');
  run(['lock', '--out', out], { env: withIndex(p.indexDir), cwd: p.root });

  const r = run(['check', '--lock', out], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0);
  assert.match(r.out, /clean|no drift/);
});

it('check exits 1 when a pinned version starts doing something new', () => {
  // The whole point of the file. The version did not move; the behaviour did.
  const p = project([['alpha', '1.0.0']]);
  const out = path.join(p.root, 'apollo.lock');
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
  const out = path.join(p.root, 'apollo.lock');
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

/* ── --index: somebody else's repository, somebody else's index ───────────── */

it('a project with no index of its own can use a published one', () => {
  /*
   * The adoption story, as a test.
   *
   * Every check above hands the CLI an index it built itself. That is the only way this tool has
   * ever been usable, and it means the first thing a new user has to do is install two thousand
   * packages — which makes the project's own claim ("run a package once, answer for every
   * repository") unverifiable by exactly the person it is addressed to.
   *
   * Here the project has NO index. It has a published file, the way a stranger would have a URL,
   * and everything works.
   */
  const p = project([['alpha', '1.0.0'], ['beta', '2.0.0', { env: ['CI'] }]]);
  const published = path.join(p.root, 'published.json');
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'scripts', 'publish-index.js'), '--out', published],
    { env: { ...process.env, APOLLO_INDEX: p.indexDir }, stdio: 'ignore', cwd: __dirname }
  );

  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'no-index-at-all-'));
  const out = path.join(p.root, 'apollo.lock');

  const locked = run(['lock', '--index', published, '--out', out], {
    env: withIndex(nowhere),
    cwd: p.root,
  });
  assert.equal(locked.code, 0, locked.out);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).packages).sort(),
    ['alpha@1.0.0', 'beta@2.0.0']
  );

  const checked = run(['check', '--index', published, '--lock', out], {
    env: withIndex(nowhere),
    cwd: p.root,
  });
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /clean — every package does exactly what the lock says/);

  fs.rmSync(nowhere, { recursive: true, force: true });
});

it('a package the published index has never seen is unknown, not clean', () => {
  /*
   * The state a stranger's tree will actually be in. Most of npm has been watched by nobody, so a
   * published index answers part of a tree and not the rest — and the part it did not answer must
   * never be quietly counted as fine. `--fail-on-unknown` is how a pipeline says it cares.
   */
  const p = project([['alpha', '1.0.0']]);
  const published = path.join(p.root, 'published.json');
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'scripts', 'publish-index.js'), '--out', published],
    { env: { ...process.env, APOLLO_INDEX: p.indexDir }, stdio: 'ignore', cwd: __dirname }
  );

  // A second package appears in the tree that the published index has never observed.
  const lockfile = path.join(p.root, 'package-lock.json');
  const tree = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  tree.packages['node_modules/never-watched'] = { name: 'never-watched', version: '9.9.9' };
  fs.writeFileSync(lockfile, JSON.stringify(tree));

  const out = path.join(p.root, 'apollo.lock');
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'no-index-at-all-'));

  run(['lock', '--index', published, '--out', out], { env: withIndex(nowhere), cwd: p.root });

  const relaxed = run(['check', '--index', published, '--lock', out], { env: withIndex(nowhere), cwd: p.root });
  assert.equal(relaxed.code, 0, 'an unknown package failed the build by default');
  assert.match(relaxed.out, /never seen|unknown/i, 'the unknown package was not mentioned at all');

  const strict = run(['check', '--index', published, '--lock', out, '--fail-on-unknown'], {
    env: withIndex(nowhere), cwd: p.root,
  });
  assert.equal(strict.code, 2, 'asked to fail on unknown, and did not');

  fs.rmSync(nowhere, { recursive: true, force: true });
});

it('an index URL that does not answer is an environment error, not a finding', () => {
  /*
   * Exit 3, never exit 1. A pipeline that cannot tell a broken run from a real finding teaches
   * people to ignore the real finding.
   */
  const p = project([['alpha', '1.0.0']]);
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'no-index-at-all-'));
  const r = run(['lock', '--index', path.join(p.root, 'does-not-exist.json')], {
    env: withIndex(nowhere), cwd: p.root,
  });
  assert.equal(r.code, 3, `exited ${r.code} instead of 3`);
  assert.match(r.out, /Could not read the index/);
  fs.rmSync(nowhere, { recursive: true, force: true });
});

it('check with no lock exits 3, not 1', () => {
  // "You have not run lock yet" is an environment problem, not a finding.
  const p = project([['alpha', '1.0.0']]);
  const r = run(['check', '--lock', path.join(p.root, 'nope.lock')], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 3);
  assert.match(r.out, /apollo lock/);
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

/* ── apollo upgrade ───────────────────────────────────────────────────── */

/** A project under git: the lockfile committed at one set of versions, then moved on disk. */
function bumped(was, now, indexPackages = []) {
  const p = project(indexPackages);
  const lockAt = (deps) => JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...Object.fromEntries(deps.map(([n, v]) => [`node_modules/${n}`, { version: v }])) } });
  const git = (...a) => execFileSync('git', a, { cwd: p.root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  fs.writeFileSync(path.join(p.root, 'package-lock.json'), lockAt(was));
  git('init', '-q'); git('add', 'package-lock.json'); git('commit', '-q', '-m', 'before');
  fs.writeFileSync(path.join(p.root, 'package-lock.json'), lockAt(now));
  const watched = path.join(p.root, 'watched.json');
  fs.writeFileSync(watched, JSON.stringify({ count: 2, pairs: {
    'source-map-js': { '1.2.1→1.2.2': { severity: 'alarming', reasons: ['builds and runs code that did not exist in the source (Function)'], gained: { exec: { added: ['{"how":"Function","sample":"return 0"}'], removed: [] } } } },
    chalk: { '5.3.0→5.4.0': { severity: 'none' } },
  } }));
  return { ...p, watched };
}

it('`upgrade` exits 1 on a bump the watch saw behave differently, and prints the evidence in words', () => {
  const p = bumped([['source-map-js', '1.2.1'], ['chalk', '5.3.0']], [['source-map-js', '1.2.2'], ['chalk', '5.4.0']]);
  const r = run(['upgrade', '--watched', p.watched], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /2 versions moved since HEAD/);
  assert.match(r.out, /alarming\s+.*source-map-js.* 1\.2\.1 → 1\.2\.2/);
  assert.match(r.out, /\+ exec\s+Function\("return 0"\)/);
  assert.match(r.out, /1 upgrade compared, behaving the same as before/);
  assert.match(r.out, /never "malicious"/);
});

it('`upgrade` exits 0 when every bump was compared and none changed — and when nothing moved at all', () => {
  const same = bumped([['chalk', '5.3.0']], [['chalk', '5.4.0']]);
  const r = run(['upgrade', '--watched', same.watched], { env: withIndex(same.indexDir), cwd: same.root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing to stop for/);
  const still = bumped([['chalk', '5.3.0']], [['chalk', '5.3.0']]);
  const n = run(['upgrade', '--watched', still.watched], { env: withIndex(still.indexDir), cwd: still.root });
  assert.equal(n.code, 0);
  assert.match(n.out, /Nothing was upgraded/);
});

it('`upgrade` names a bump nobody compared as unknown: 0 by default, 2 with --fail-on-unknown', () => {
  const p = bumped([['left-pad', '1.2.0']], [['left-pad', '1.3.0']]);
  const r = run(['upgrade', '--watched', p.watched], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 upgrade nobody has compared/);
  assert.match(r.out, /left-pad 1\.2\.0 → 1\.3\.0/);
  assert.equal(run(['upgrade', '--watched', p.watched, '--fail-on-unknown'], { env: withIndex(p.indexDir), cwd: p.root }).code, 2);
});

it('`upgrade` with no watched releases to read still answers from the index, and says the watch was missing', () => {
  const p = bumped([['picocolors', '1.1.0']], [['picocolors', '1.1.1']], [['picocolors', '1.1.0'], ['picocolors', '1.1.1', { env: ['NO_COLOR'] }]]);
  const r = run(['upgrade', '--watched', path.join(p.root, 'absent.json')], { env: withIndex(p.indexDir), cwd: p.root });
  assert.equal(r.code, 0, 'reading NO_COLOR failed a build');
  assert.match(r.out, /no watched releases at/);
  assert.match(r.out, /minor\s+.*picocolors/);
  assert.match(r.out, /both versions in the index/);
});

console.log(`\n${passed} passed`);
