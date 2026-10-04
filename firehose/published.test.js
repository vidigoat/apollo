/**
 * The live watch's ledger, bundled or fresher.
 *
 *   node firehose/published.test.js
 *
 * Nothing here reaches a network: fetch is handed in. What is tested is every way a "fresher"
 * source could make the answer worse — being older, broken, slow, or the wrong shape.
 */
const assert = require('node:assert');
const { fresh, current, reset, TTL_MS } = require('./published');

let passed = 0;
const it = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
const ledger = (at, pairs = { a: { '1→2': { severity: 'none' } } }) => ({ publishedAt: at, pairs });
const serving = (body, ok = true) => async () => ({ ok, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const SRC = { watchedReleases: 'https://example.invalid/watched-releases.json' };

(async () => {
  console.log('the published ledger');

  await it('a newer published ledger replaces the bundled one', async () => {
    reset(ledger('2026-10-01T00:00:00Z'));
    const got = await fresh({ source: SRC, fetchImpl: serving(ledger('2026-10-04T00:00:00Z', { b: { '1→2': { severity: 'alarming' } } })) });
    assert.equal(got.publishedAt, '2026-10-04T00:00:00Z');
    assert.ok(got.pairs.b);
    assert.equal(current(), got);
  });

  await it('an older one, a broken one, a failing one or the wrong shape changes nothing', async () => {
    for (const fetchImpl of [
      serving(ledger('2026-09-01T00:00:00Z')),
      serving('<html>not json'),
      serving(ledger('2026-10-09T00:00:00Z'), false),
      serving({ publishedAt: '2026-10-09T00:00:00Z', pairs: [] }),
      serving({ publishedAt: '2026-10-09T00:00:00Z' }),
      async () => { throw new Error('unreachable'); },
    ]) {
      reset(ledger('2026-10-01T00:00:00Z'));
      const got = await fresh({ source: SRC, fetchImpl });
      assert.equal(got.publishedAt, '2026-10-01T00:00:00Z');
    }
  });

  await it('it asks at most once per ten minutes, and never without a source to ask', async () => {
    reset(ledger('2026-10-01T00:00:00Z'));
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, text: async () => JSON.stringify(ledger('2026-10-02T00:00:00Z')) }; };
    let t = 1_000_000_000;
    await fresh({ source: SRC, fetchImpl, now: () => t });
    await fresh({ source: SRC, fetchImpl, now: () => t + 60_000 });
    assert.equal(calls, 1, 'asked again inside the ten minutes');
    await fresh({ source: SRC, fetchImpl, now: () => t + TTL_MS + 1 });
    assert.equal(calls, 2);
    reset(ledger('2026-10-01T00:00:00Z'));
    calls = 0;
    for (const source of [null, {}, { watchedReleases: 'http://plain.example/x.json' }, { watchedReleases: 7 }]) {
      reset(ledger('2026-10-01T00:00:00Z'));
      await fresh({ source, fetchImpl });
    }
    assert.equal(calls, 0, 'fetched from something that is not an https source');
  });

  console.log(`\n${passed} passed`);
})();
