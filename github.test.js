/**
 * The GitHub App.
 *
 *   node github.test.js
 *
 * Two things here are worth being sure about, and neither of them needs GitHub.
 *
 *   the front door   A webhook is a URL on the open internet that anybody can POST to, and this
 *                    one decides what a check run says about somebody's pull request. The
 *                    signature check has to run before anything else and has to be constant-time.
 *   the verdict      What it SAYS. A check run that reports "passed" over a tree the index has
 *                    never seen would be the most dishonest thing this project could ship, and it
 *                    is one line away at all times.
 *
 * Everything that talks to GitHub is injected, so every decision below is exercised against the
 * same code that runs in production with none of the ceremony.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verify, interesting, checkRun } = require('./github/webhook');
const { appJwt } = require('./github/api');
const { handle } = require('./github/handle');
const { Index } = require('./index/schema');

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

const SECRET = 'not-the-real-one';
const sign = (raw, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

const transcript = (version, over = {}) => ({
  pkg: 'p', version, strategy: 'nodert',
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
  net: [], dns: [], fs: [], env: [], proc: [], exec: [],
  ...over,
});

/** A throwaway index holding exactly what a test needs it to. */
function indexWith(packages) {
  const idx = new Index({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gh-idx-')) });
  for (const [name, version, over] of packages) idx.put(name, transcript(version, over));
  idx.writeManifest({ revision: 'test' });
  return idx;
}

const lockfileText = (deps) =>
  JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture' },
      ...Object.fromEntries(deps.map(([n, v]) => [`node_modules/${n}`, { name: n, version: v }])),
    },
  });

const delivery = (over = {}) => ({
  action: 'opened',
  installation: { id: 42 },
  repository: { name: 'app', owner: { login: 'someone' } },
  pull_request: { number: 7, draft: false, head: { sha: 'abc1234def' } },
  ...over,
});

/** The GitHub side, recorded rather than performed. */
function wiredTo({ files = ['package-lock.json'], contents = {} } = {}) {
  const posted = [];
  return {
    posted,
    wired: {
      installationToken: async () => 'tok',
      filesIn: async () => files,
      fileAt: async ({ path: p }) => contents[p] ?? null,
      postCheck: async ({ run }) => { posted.push(run); return { id: 1 }; },
    },
  };
}

(async () => {
  console.log('the github app');

  /* ── the front door ───────────────────────────────────────────────────── */

  await it('a body with no signature is refused', () => {
    assert.equal(verify('{}', undefined, SECRET).ok, false);
  });

  await it('a body signed with the wrong secret is refused', () => {
    const raw = JSON.stringify(delivery());
    assert.equal(verify(raw, sign(raw, 'someone-elses-secret'), SECRET).ok, false);
  });

  await it('a body altered after signing is refused', () => {
    // The whole point. A signature over the body it was computed for, not over the shape of it.
    const raw = JSON.stringify(delivery());
    const good = sign(raw);
    const tampered = raw.replace('"number":7', '"number":8');
    assert.equal(verify(tampered, good, SECRET).ok, false);
  });

  await it('a server with no secret configured refuses everything', () => {
    /*
     * The dangerous default. An app deployed without its secret set would otherwise accept any
     * POST from anyone and post check runs on their behalf — and it would look like it was working.
     */
    const raw = JSON.stringify(delivery());
    assert.equal(verify(raw, sign(raw), undefined).ok, false);
    assert.equal(verify(raw, sign(raw), '').ok, false);
  });

  await it('a correctly signed body is accepted', () => {
    const raw = JSON.stringify(delivery());
    assert.equal(verify(raw, sign(raw), SECRET).ok, true);
  });

  await it('a signature of the wrong length does not throw', () => {
    // `timingSafeEqual` throws on mismatched lengths, and a webhook endpoint that 500s on a
    // malformed signature is one somebody can turn into an alert storm.
    assert.equal(verify('{}', 'sha256=short', SECRET).ok, false);
  });

  /* ── which deliveries are worth acting on ─────────────────────────────── */

  await it('ping is answered, because GitHub uses it to prove the endpoint is alive', () => {
    assert.equal(interesting('ping', {}).pong, true);
  });

  await it('a draft pull request is left alone', () => {
    const d = interesting('pull_request', { action: 'opened', pull_request: { draft: true } });
    assert.equal(d.act, false);
  });

  await it('a closed pull request is not work', () => {
    assert.equal(interesting('pull_request', { action: 'closed' }).act, false);
    assert.equal(interesting('issues', { action: 'opened' }).act, false);
  });

  await it('a push to an open pull request IS work', () => {
    // `synchronize` is the one that matters: the dependency bump usually arrives as a second push.
    assert.equal(interesting('pull_request', { action: 'synchronize', pull_request: {} }).act, true);
  });

  /* ── what it says ─────────────────────────────────────────────────────── */

  await it('drift fails the check and names what changed', () => {
    const run = checkRun({
      checked: 3,
      drift: [{ package: 'left-pad@1.3.0', changes: [{ channel: 'env', before: [], after: ['AWS_SECRET_ACCESS_KEY'] }] }],
      unknown: [],
      added: [],
    });
    assert.equal(run.conclusion, 'failure');
    assert.match(run.summary, /AWS_SECRET_ACCESS_KEY/);
    assert.match(run.summary, /version did not move/i);
  });

  await it('drift in what an install script does is named as install-time, in words', () => {
    const run = checkRun({
      checked: 1,
      drift: [{ package: 'native@1.0.0', changes: [{ channel: 'install.env', before: [], after: ['NPM_TOKEN'] }] }],
      unknown: [],
      added: [],
    });
    assert.equal(run.conclusion, 'failure');
    assert.match(run.summary, /at install, env: now NPM_TOKEN/);
  });

  await it('unknown is NEUTRAL, never failure', () => {
    /*
     * The most important assertion in this file.
     *
     * On any real tree most packages start unknown. A check that goes red on day one is a check
     * somebody disables in week one — and then the day it has something real to say, nobody is
     * listening.
     */
    const run = checkRun({ checked: 2, drift: [], unknown: ['a@1.0.0', 'b@2.0.0'], added: [] });
    assert.equal(run.conclusion, 'neutral');
    assert.notEqual(run.conclusion, 'failure');
    assert.match(run.summary, /never been observed/);
    assert.match(run.summary, /a@1\.0\.0/, 'it did not say WHICH ones');
  });

  await it('a clean check says how many it checked, so the number can be argued with', () => {
    const run = checkRun({ checked: 12, drift: [], unknown: [], added: [] }, { total: 12 });
    assert.equal(run.conclusion, 'success');
    assert.match(run.title, /12/);
  });

  await it('drift outranks unknown — a finding is never buried under a caveat', () => {
    const run = checkRun({
      checked: 5,
      drift: [{ package: 'p@1.0.0', changes: [{ channel: 'net', before: [], after: [{ host: 'evil.example', port: 443 }] }] }],
      unknown: ['x@1.0.0', 'y@1.0.0', 'z@1.0.0'],
      added: [],
    });
    assert.equal(run.conclusion, 'failure');
    assert.match(run.summary, /evil\.example/);
  });

  /* ── the whole path, with GitHub injected ─────────────────────────────── */

  await it('an unsigned delivery gets 401 and nothing is posted', async () => {
    const { posted, wired } = wiredTo();
    const out = await handle(
      { raw: JSON.stringify(delivery()), signature: 'sha256=nope', event: 'pull_request' },
      { secret: SECRET, index: indexWith([]) },
      wired
    );
    assert.equal(out.status, 401);
    assert.equal(posted.length, 0, 'it posted a check run for an unverified delivery');
  });

  await it('a pull request with no lockfile costs one call and posts nothing', async () => {
    // A check run saying "no dependencies changed" on every pull request is noise that teaches
    // people to ignore the name.
    const raw = JSON.stringify(delivery());
    const { posted, wired } = wiredTo({ files: ['README.md', 'src/index.js'] });
    const out = await handle({ raw, signature: sign(raw), event: 'pull_request' },
      { secret: SECRET, index: indexWith([['lodash', '4.17.21']]) }, wired);

    assert.equal(out.status, 200);
    assert.match(out.body.skipped, /no lockfile/);
    assert.equal(posted.length, 0);
  });

  await it('a lockfile of packages the index has seen, with no drift, passes', async () => {
    const raw = JSON.stringify(delivery());
    const idx = indexWith([['lodash', '4.17.21']]);
    const { buildLock } = require('./lock');
    const { parseLockfile } = require('./lockfile');
    const text = lockfileText([['lodash', '4.17.21']]);
    const { lock } = buildLock(parseLockfile(text).versions, idx);

    const { posted, wired } = wiredTo({
      contents: { 'package-lock.json': text, 'stakeout.lock': JSON.stringify(lock) },
    });
    const out = await handle({ raw, signature: sign(raw), event: 'pull_request' },
      { secret: SECRET, index: idx }, wired);

    assert.equal(out.body.posted, 'success');
    assert.equal(posted[0].conclusion, 'success');
  });

  await it('behaviour changing under an unmoved version fails the pull request', async () => {
    /*
     * The product, on the surface where the decision is made. The lockfile in the PR is identical
     * to the one the lock was written from — same package, same version — and the check still
     * fails, because the package started reading a credential.
     */
    const raw = JSON.stringify(delivery());
    const idx = indexWith([['lodash', '4.17.21']]);
    const { buildLock } = require('./lock');
    const { parseLockfile } = require('./lockfile');
    const text = lockfileText([['lodash', '4.17.21']]);
    const { lock } = buildLock(parseLockfile(text).versions, idx);

    idx.put('lodash', transcript('4.17.21', { env: ['AWS_SECRET_ACCESS_KEY'] }));
    idx.writeManifest({ revision: 'test' });

    const { posted, wired } = wiredTo({
      contents: { 'package-lock.json': text, 'stakeout.lock': JSON.stringify(lock) },
    });
    const out = await handle({ raw, signature: sign(raw), event: 'pull_request' },
      { secret: SECRET, index: idx }, wired);

    assert.equal(out.body.posted, 'failure');
    assert.match(posted[0].summary, /AWS_SECRET_ACCESS_KEY/);
  });

  await it('a repository with no stakeout.lock still gets a real answer', async () => {
    // The first experience: install the app, open a PR, see how much of your tree is already known.
    const raw = JSON.stringify(delivery());
    const idx = indexWith([['lodash', '4.17.21']]);
    const { posted, wired } = wiredTo({
      contents: { 'package-lock.json': lockfileText([['lodash', '4.17.21'], ['ghost', '9.9.9']]) },
    });
    const out = await handle({ raw, signature: sign(raw), event: 'pull_request' },
      { secret: SECRET, index: idx }, wired);

    assert.equal(out.status, 200);
    assert.equal(posted.length, 1, 'it said nothing at all');
    assert.equal(posted[0].conclusion, 'neutral', 'an unindexed package failed somebody\'s build');
    assert.match(posted[0].summary, /ghost@9\.9\.9/);
  });

  await it('a server with no index says so rather than staying silent', async () => {
    const raw = JSON.stringify(delivery());
    const empty = new Index({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gh-none-')) });
    const { posted, wired } = wiredTo({ contents: { 'package-lock.json': lockfileText([['a', '1.0.0']]) } });
    await handle({ raw, signature: sign(raw), event: 'pull_request' }, { secret: SECRET, index: empty }, wired);

    assert.equal(posted[0].conclusion, 'neutral');
    assert.match(posted[0].title, /no behavioural index/);
  });

  /* ── proving we are the app ───────────────────────────────────────────── */

  await it('the app JWT is signed, backdated, and expires within ten minutes', () => {
    /*
     * Backdated sixty seconds because GitHub rejects a token issued in the future and two
     * machines' clocks are never quite the same — a whole afternoon, the first time you meet it.
     */
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Date.now();
    const token = appJwt({ appId: '123', privateKey, now });

    const [h, c, sigPart] = token.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.iss, '123');
    assert.ok(claims.iat <= Math.floor(now / 1000) - 60);
    assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses anything longer than ten minutes');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256');

    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`),
      publicKey, Buffer.from(sigPart, 'base64url'));
    assert.equal(ok, true, 'the signature does not verify against its own key');
  });

  await it('a JWT cannot be made without a key', () => {
    assert.throws(() => appJwt({ appId: '123' }), /private key/);
  });

  /* ── the route, over real HTTP ────────────────────────────────────────── */

  /*
   * The tests above prove the decision. These prove the wire: that the bytes GitHub signed are the
   * bytes this server hashes. Everything in between — a framework that parses JSON, a host that
   * reads the body first — breaks the signature without breaking anything that looks broken.
   */
  const http = require('node:http');
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const handler = require('./server');
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const at = `http://127.0.0.1:${server.address().port}/api/github/webhook`;

  const post = (raw, headers = {}) =>
    fetch(at, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  await it('GET is not a webhook', async () => {
    const r = await fetch(at);
    assert.equal(r.status, 405);
  });

  await it('an unsigned POST is refused by the live route', async () => {
    const r = await post(JSON.stringify(delivery()));
    assert.equal(r.status, 401);
    assert.match(r.body.reason, /signature/);
  });

  await it('the signature is checked against the bytes, whitespace and all', async () => {
    /*
     * The one that catches body-parsing. This body is pretty-printed with an odd key order — the
     * shape of a real delivery, not of `JSON.stringify(parsed)`. If anything between the socket and
     * `verify` re-serialises it, this test fails and the app would have rejected every genuine
     * delivery GitHub ever sent it.
     */
    const raw = '{\n  "zen": "Design for failure.",\n  "hook_id": 1,\n  "spaced"  :  true\n}';
    const r = await post(raw, { 'x-hub-signature-256': sign(raw), 'x-github-event': 'ping' });
    assert.equal(r.status, 200);
    assert.equal(r.body.pong, true);
  });

  await it('a body altered in flight is refused by the live route', async () => {
    const raw = JSON.stringify(delivery());
    const good = sign(raw);
    const r = await post(raw.replace('"number":7', '"number":9'), {
      'x-hub-signature-256': good, 'x-github-event': 'pull_request',
    });
    assert.equal(r.status, 401);
  });

  await it('a delivery this app has nothing to do about is answered, not dropped', async () => {
    const raw = JSON.stringify({ action: 'labeled' });
    const r = await post(raw, { 'x-hub-signature-256': sign(raw), 'x-github-event': 'issues' });
    assert.equal(r.status, 200);
    assert.match(r.body.skipped, /issues/);
  });

  server.close();
  console.log(`\n${passed} passed`);
})();
