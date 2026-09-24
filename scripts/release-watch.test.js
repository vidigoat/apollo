/**
 * The release watch picks which two versions to compare, and what a person reads about the change.
 *
 *   node scripts/release-watch.test.js
 *
 * Nothing here reaches npm or Nebius. What is tested is the choice of pair — the newest stable
 * release against the stable release before it, never a prerelease and never a later backport —
 * and that the summary of a change carries the install phase when there is one.
 */
const assert = require('node:assert');
const { lastTwo, gained, scopedDownloads } = require('./release-watch');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};

(async () => {
  console.log('release watch');

  await it('the pair is latest against the stable release just below it — not a prerelease, not a backport', () => {
    const meta = { 'dist-tags': { latest: '4.1.5' }, versions: { '4.1.3': {}, '4.1.4': {}, '4.1.5': {}, '4.1.10': {}, '5.0.0-beta.1': {} } };
    assert.deepEqual(lastTwo(meta), ['4.1.4', '4.1.5']);
    assert.deepEqual(lastTwo({ 'dist-tags': { latest: '10.0.0' }, versions: { '9.9.9': {}, '10.0.0': {}, '2.0.0': {} } }), ['9.9.9', '10.0.0'], 'compared as text, not as numbers');
  });

  await it('nothing to compare is null, never a pair invented from nothing', () => {
    assert.equal(lastTwo({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }), null);
    assert.equal(lastTwo({ 'dist-tags': { latest: '2.0.0-rc.1' }, versions: { '1.0.0': {}, '2.0.0-rc.1': {} } }), null);
    assert.equal(lastTwo(null), null);
  });

  await it('what changed at install is reported as install.<channel>, apart from the import', () => {
    const none = { added: [], removed: [] };
    const d = {
      net: none, dns: none, fs: none, proc: none, exec: none,
      env: { added: ['CI'], removed: [] },
      install: { net: { added: [{ host: 'x.example', port: 443, proto: 'tls' }], removed: [] }, dns: none, fs: none, env: none, proc: none, exec: none },
    };
    const g = gained(d);
    assert.deepEqual(g.env.added, ['CI']);
    assert.match(g['install.net'].added[0], /x\.example/);
    assert.equal(g.net, undefined);
  });

  await it('scoped ranking skips @types, which has no runtime to watch', async () => {
    const asked = [];
    const fake = async (url) => { asked.push(url); return { ok: true, json: async () => ({ downloads: 5 }) }; };
    const r = await scopedDownloads(['@babel/core', '@types/node', 'left-pad'], fake);
    assert.deepEqual([...r.keys()], ['@babel/core']);
    assert.equal(asked.length, 1);
    assert.equal(r.asked, 1);
  });

  await it('a rate limit is waited out and asked again, not dropped without a word', async () => {
    let n = 0;
    const fake = async () => (++n <= 2 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ downloads: 9 }) });
    const r = await scopedDownloads(['@x/y'], fake, async () => {});
    assert.equal(r.get('@x/y'), 9, 'a 429 lost the package');
    assert.equal(n, 3);
  });

  await it('a ranking with a chunk npm would not answer is refused, not published as the top', async () => {
    const { weeklyDownloads } = require('./release-watch');
    let calls = 0;
    const flaky = async () => (++calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => ({ a: { downloads: 3 } }) });
    const r = await weeklyDownloads(['a'], flaky, async () => {});
    assert.equal(r.get('a'), 3, 'a 429 lost the chunk');
    const dead = async () => ({ ok: false, status: 429 });
    await assert.rejects(() => weeklyDownloads(['a'], dead, async () => {}), /refusing to call a partial ranking/);
  });

  await it('the site gets the counts and the pairs that moved, not every unchanged pair', () => {
    const { slim } = require('./release-watch');
    const record = { measured: 'm', notes: { a: 'n' }, results: {
      'a@1→2': { severity: 'minor', pkg: 'a' }, 'b@1→2': { severity: 'none', pkg: 'b' }, 'c@1→2': { severity: 'none', pkg: 'c' }, 'd@1→2': { severity: 'unobserved', pkg: 'd' },
    } };
    const s = slim(record);
    assert.equal(s.total, 4);
    assert.deepEqual(s.tally, { minor: 1, none: 2, unobserved: 1 });
    assert.deepEqual(Object.keys(s.results).sort(), ['a@1→2', 'd@1→2']);
    assert.deepEqual(s.notes, { a: 'n' });
  });

  console.log(`\n${passed} passed`);
})();
