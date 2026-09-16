/**
 * The transcript.
 *
 * Everything downstream is a set difference over these records, which means the differ is only as
 * truthful as this file is. Two failure modes, opposite and both fatal:
 *
 *   UNDER-NORMALISING  A pid, a temp directory or a cache key that varies between two runs of the
 *                      SAME version shows up as a behavioural difference. Every package looks
 *                      guilty, the tool is noise, nobody reads it.
 *
 *   OVER-NORMALISING   Something that carries meaning gets flattened away, and a real difference
 *                      compares equal. The attack gets a clean bill of health.
 *
 * So the test is a pair: identical runs must compare equal, and meaningful differences must not.
 *
 * Run: node transcript/schema.test.js
 */

const assert = require('node:assert');
const { transcript, isQuiet, normalisePath, STRATEGIES, CAN_SEE } = require('./schema');

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

const t = (raw, strategy = 'ebpf') => transcript({ pkg: 'p', version: '1', strategy, raw });
const same = (a, b) => assert.deepEqual(a, b);

console.log('transcript');

/* ── it must say how it was made ──────────────────────────────────────── */

it('refuses to exist without a strategy — a transcript must say how it was made', () => {
  assert.throws(() => transcript({ pkg: 'p', version: '1', strategy: 'vibes' }), /must say how it was made/);
  STRATEGIES.forEach((s) => assert.ok(transcript({ pkg: 'p', version: '1', strategy: s })));
});

it('carries what its strategy could not see', () => {
  assert.equal(t({}, 'fsdiff').canSee.net, false, 'fsdiff cannot see the network and must admit it');
  assert.equal(t({}, 'ebpf').canSee.env, true);
  assert.equal(t({}, 'proxy').canSee.proc, false);
  // Every strategy must answer for every field, or a caveat silently goes missing.
  const fields = ['fs', 'net', 'dns', 'env', 'proc'];
  STRATEGIES.forEach((s) => fields.forEach((f) =>
    assert.equal(typeof CAN_SEE[s][f], 'boolean', `${s} does not say whether it can see ${f}`)));
});

/* ── identical runs must compare equal ────────────────────────────────── */

it('two runs that differ only in pids compare equal', () => {
  same(t({ proc: [{ argv: ['node', '/proc/4821/cmdline'] }] }).proc,
       t({ proc: [{ argv: ['node', '/proc/91733/cmdline'] }] }).proc);
});

it('two runs that differ only in temp directories compare equal', () => {
  same(t({ fs: [{ op: 'write', path: '/tmp/npm-9a8b/x' }] }).fs,
       t({ fs: [{ op: 'write', path: '/tmp/npm-3f1c/x' }] }).fs);
  // macOS varies at several depths at once. Eating one segment is not enough.
  same(t({ fs: [{ op: 'write', path: '/var/folders/qz/8xk_p3/T/abc/y' }] }).fs,
       t({ fs: [{ op: 'write', path: '/var/folders/qz/l2m_99/T/xyz/y' }] }).fs);
  same(t({ fs: [{ op: 'write', path: '/private/var/folders/qz/a/T/b/y' }] }).fs,
       t({ fs: [{ op: 'write', path: '/private/var/folders/qz/c/T/d/y' }] }).fs);
});

it('what was written to a temp directory still survives — only where it went is collapsed', () => {
  assert.equal(normalisePath('/var/folders/qz/8xk/T/abc/backdoor.sh'), '/tmp/·/backdoor.sh');
  assert.equal(normalisePath('/tmp/npm-1a2b/postinstall.js'), '/tmp/·/postinstall.js');
  assert.notDeepEqual(t({ fs: [{ op: 'write', path: '/tmp/a/backdoor.sh' }] }).fs,
                      t({ fs: [{ op: 'write', path: '/tmp/a/readme.md' }] }).fs);
});

it('two runs that differ only in cache contents compare equal', () => {
  same(t({ fs: [{ op: 'write', path: '/home/u/.cache/a/b/c' }] }).fs,
       t({ fs: [{ op: 'write', path: '/home/u/.cache/z/y/x' }] }).fs);
});

it('two runs that differ only in content hashes compare equal', () => {
  same(t({ fs: [{ op: 'write', path: '/app/node_modules/.package-lock.json.d41d8cd98f00b204' }] }).fs,
       t({ fs: [{ op: 'write', path: '/app/node_modules/.package-lock.json.9e107d9d372bb682' }] }).fs);
});

it('order and duplication do not survive — a transcript is a set', () => {
  same(t({ dns: ['b.example', 'a.example', 'B.EXAMPLE'] }).dns, ['a.example', 'b.example']);
  same(t({ env: ['B', 'A', 'A'] }).env, ['A', 'B']);
  assert.equal(t({ net: [
    { host: 'a.example', port: 443, proto: 'tcp' },
    { host: 'A.example', port: 443, proto: 'tcp' },
  ] }).net.length, 1, 'the same destination twice is one fact');
});

/* ── meaningful differences must survive ──────────────────────────────── */

it('a different host is still a different host', () => {
  assert.notDeepEqual(t({ net: [{ host: 'a.example', port: 443 }] }).net,
                      t({ net: [{ host: 'b.example', port: 443 }] }).net);
});

it('a different port on the same host survives', () => {
  assert.notDeepEqual(t({ net: [{ host: 'a.example', port: 443 }] }).net,
                      t({ net: [{ host: 'a.example', port: 8080 }] }).net);
});

it('a path outside the noisy directories survives intact', () => {
  same(t({ fs: [{ op: 'write', path: '/app/src/index.js' }] }).fs,
       [{ op: 'write', path: '/app/src/index.js' }]);
  assert.equal(normalisePath('/etc/ssh/authorized_keys'), '/etc/ssh/authorized_keys',
    'normalising this away would hide a real attack');
});

it('reading a credential is not normalised away', () => {
  same(t({ env: ['AWS_SECRET_ACCESS_KEY'] }).env, ['AWS_SECRET_ACCESS_KEY']);
});

it('a version number in a path is not mistaken for a pid', () => {
  // PID_LIKE is \b\d{3,7}\b — two-digit and one-digit runs must survive, and so must the name.
  assert.match(normalisePath('/app/node_modules/left-pad/index.js'), /left-pad/);
  assert.equal(normalisePath('/app/v2/lib.js'), '/app/v2/lib.js');
});

/* ── shape ────────────────────────────────────────────────────────────── */

it('missing fields become empty ones, not undefined', () => {
  const x = t({});
  ['net', 'dns', 'fs', 'env', 'proc'].forEach((f) => same(x[f], []));
  assert.equal(x.timing.installMs, null);
  assert.equal(x.result.threw, null, 'unknown must stay null, never false');
});

it('quiet means genuinely nothing, in every channel', () => {
  assert.equal(isQuiet(t({})), true);
  ['net', 'dns', 'env'].forEach((f) => assert.equal(isQuiet(t({ [f]: ['x'] })), false, `${f} was ignored`));
  assert.equal(isQuiet(t({ fs: [{ op: 'write', path: '/a' }] })), false);
  assert.equal(isQuiet(t({ proc: [{ argv: ['sh'] }] })), false);
});

it('a transcript is stable — building it twice from the same input gives the same bytes', () => {
  const raw = {
    net: [{ host: 'b.example', port: 443, proto: 'tcp' }, { host: 'a.example', port: 80, proto: 'tcp' }],
    fs: [{ op: 'write', path: '/tmp/x1/f' }, { op: 'read', path: '/app/a' }],
    env: ['Z', 'A'], dns: ['b.example'], proc: [{ argv: ['sh', '-c', 'true'] }],
  };
  assert.equal(JSON.stringify(t(raw)), JSON.stringify(t(raw)));
});

console.log(`\n${passed} passed`);
