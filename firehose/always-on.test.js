/**
 * Running for weeks on machines that come and go: the state mirror, the heartbeat's judge, and the
 * supervisor that restarts a dead watcher.
 *
 *   node firehose/always-on.test.js
 *
 * Nothing reaches object storage or Nebius: fetch is handed in, and the supervisor supervises a
 * script that crashes on purpose.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Mirror, sign } = require('./mirror');
const { judge } = require('../scripts/firehose-health');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'always-on-'));

/** A tiny object store: a Map, and the requests it was sent. */
function store() {
  const objects = new Map();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, ...opts });
    if (opts.method === 'PUT') { objects.set(url, opts.body); return { ok: true, status: 200, text: async () => '' }; }
    if (!objects.has(url)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => objects.get(url) };
  };
  return { objects, seen, fetchImpl };
}
const env = { APOLLO_STATE_S3: 's3://stakeout-watch/live', APOLLO_S3_KEY_ID: 'AKIDEXAMPLE', APOLLO_S3_SECRET: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

(async () => {
  console.log('always on');

  await it('SigV4 matches the vector AWS publishes (get-vanilla)', () => {
    const r = sign({ method: 'GET', url: 'https://example.amazonaws.com/' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, { region: 'us-east-1', service: 'service' }, new Date('2015-08-30T12:36:00Z'));
    assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  await it('a watch pushed from one machine comes back on the next — a new job continues, it does not start over', async () => {
    const s = store();
    const a = tmp();
    fs.writeFileSync(path.join(a, 'state.json'), JSON.stringify({ seq: 132800000, startedAt: '2026-09-26T12:00:00Z' }));
    fs.writeFileSync(path.join(a, 'results.jsonl'), '{"key":"x@1→2"}\n');
    const m1 = Mirror.fromEnv(env, { fetchImpl: s.fetchImpl });
    const pushed = await m1.push(a, { force: true });
    assert.deepEqual(pushed.pushed.sort(), ['results.jsonl', 'state.json']);
    const put = s.seen.find((r) => r.method === 'PUT');
    assert.ok(put.url.startsWith('https://storage.eu-north1.nebius.cloud/stakeout-watch/live/'));
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north1\/s3\//);
    assert.ok(put.headers['x-amz-content-sha256'], 'S3 refuses a request without its payload hash');
    const b = tmp();
    const got = await Mirror.fromEnv(env, { fetchImpl: s.fetchImpl }).restore(b);
    assert.equal(got, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(b, 'state.json'), 'utf8')).seq, 132800000);
  });

  await it('restore never overwrites a watch that is already here, and an unreadable mirror stops the start', async () => {
    const s = store();
    const here = tmp();
    fs.writeFileSync(path.join(here, 'state.json'), '{"seq":5}');
    assert.equal(await Mirror.fromEnv(env, { fetchImpl: s.fetchImpl }).restore(here), 0);
    assert.equal(s.seen.length, 0);
    const broken = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(Mirror.fromEnv(env, { fetchImpl: broken }).restore(tmp()), /not starting over a watch that may exist/);
    // An empty mirror is a first start, which is fine.
    assert.equal(await Mirror.fromEnv(env, { fetchImpl: store().fetchImpl }).restore(tmp()), 0);
  });

  await it('pushing is once a minute, only what changed, and a failed push never throws — the watch goes on', async () => {
    const s = store();
    let t = Date.parse('2026-09-26T13:00:00Z');
    const m = Mirror.fromEnv(env, { fetchImpl: s.fetchImpl, now: () => new Date(t) });
    const d = tmp();
    fs.writeFileSync(path.join(d, 'state.json'), '{"seq":1}');
    await m.push(d);
    t += 30000;
    assert.equal((await m.push(d)).skipped, true, 'pushed twice inside a minute');
    t += 40000;
    assert.deepEqual((await m.push(d)).pushed, [], 'an unchanged file was uploaded again');
    const dead = Mirror.fromEnv(env, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    const r = await dead.push(d, { force: true });
    assert.match(r.failed[0], /ECONNRESET/);
  });

  await it('a half-configured mirror is refused at start, not discovered at the first push', () => {
    assert.equal(Mirror.fromEnv({}), null);
    assert.throws(() => Mirror.fromEnv({ APOLLO_STATE_S3: 's3://b/p' }), /KEY_ID/);
    assert.throws(() => Mirror.fromEnv({ ...env, APOLLO_STATE_S3: 'b/p' }), /s3:\/\/bucket/);
  });

  await it('the health check names each quiet failure: stopped, falling behind, reading but not watching', () => {
    const now = Date.parse('2026-09-26T13:00:00Z');
    const fresh = { at: new Date(now - 60000).toISOString(), behind: 40, due: 0, oldestPendingMinutes: 0 };
    assert.equal(judge(fresh, now).healthy, true);
    assert.match(judge({ ...fresh, at: new Date(now - 30 * 60000).toISOString() }, now).problems[0], /30 min ago/);
    assert.match(judge({ ...fresh, behind: 50000 }, now).problems[0], /50000 changes behind/);
    assert.match(judge({ ...fresh, due: 3, oldestPendingMinutes: 95 }, now).problems[0], /waited 95 min/);
  });

  await it('the supervisor restarts a watcher that dies, and stops when the hours are up', () => {
    const dir = tmp();
    const counter = path.join(dir, 'starts');
    const crashy = path.join(dir, 'crashy.js');
    // Dies twice, then stays up until told to stop — which the deadline does.
    fs.writeFileSync(crashy, `const fs=require('fs');const f=${JSON.stringify(counter)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(n));if(n<3)process.exit(1);setTimeout(()=>process.exit(0),1500);`);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'firehose-supervise.js'), '--hours', '0.0015'], {
      env: { ...process.env, APOLLO_SUPERVISE_CHILD: crashy, APOLLO_SUPERVISE_FIRST_DELAY_MS: '100' },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), 3, `started ${fs.readFileSync(counter, 'utf8')} times`);
    assert.equal((r.stdout.match(/restarting in/g) || []).length, 2);
  });

  console.log(`\n${passed} passed`);
})();
