/**
 * The public record.
 *
 * This layer decides whether a new network destination is a feature someone announced or a host
 * nobody has ever written about. Getting it wrong in either direction is expensive: a missed
 * changelog accuses an honest maintainer, and a changelog matched too loosely excuses a real
 * attack. Both failure modes are tested here.
 *
 * Run: node evidence/tavily.test.js
 */

const assert = require('node:assert');
const { lookUp, summarise, verdictFor, NOT_EVIDENCE } = require('./tavily');

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

const result = (o) => ({ url: 'https://example.com/a', title: '', content: '', ...o });

(async () => {
  console.log('public record');

  await it('a release note about this exact version counts as documentation', async () => {
    const r = summarise({ results: [
      result({ url: 'https://github.com/x/y/releases/tag/v2.2.0', title: 'Release v2.2.0', content: 'Adds retry telemetry to api.example.dev in 2.2.0.' }),
    ] }, '2.2.0');
    assert.ok(r.changelog);
    assert.match(r.verdict, /documented/);
  });

  await it('a release note about a DIFFERENT version does not excuse this one', async () => {
    const r = summarise({ results: [
      result({ url: 'https://github.com/x/y/releases/tag/v1.0.0', title: 'Release v1.0.0', content: 'Initial release.' }),
    ] }, '2.2.0');
    assert.equal(r.changelog, null, 'matched a changelog for the wrong version — this excuses real attacks');
    assert.equal(r.mentions, 0);
  });

  await it('an advisory outranks a changelog', async () => {
    const r = summarise({ results: [
      result({ url: 'https://github.com/x/y/releases/tag/v2.1.1', title: 'Release 2.1.1', content: '2.1.1 patch notes' }),
      result({ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'GHSA-aaaa-bbbb-cccc', content: 'Malicious code in 2.1.1' }),
    ] }, '2.1.1');
    assert.ok(r.advisory);
    assert.match(r.verdict, /advisory/);
  });

  await it('the registry echoing the package back is not evidence', async () => {
    ['https://www.npmjs.com/package/left-pad', 'https://libraries.io/npm/left-pad', 'https://snyk.io/advisor/npm-package/left-pad']
      .forEach((u) => assert.match(u, NOT_EVIDENCE, `${u} should not count as a source`));

    const r = summarise({ results: [
      result({ url: 'https://www.npmjs.com/package/left-pad', title: 'left-pad', content: 'left-pad 1.3.0' }),
    ] }, '1.3.0');
    assert.equal(r.mentions, 0);
    assert.deepEqual(r.sources, []);
  });

  await it('silence raises priority without proving anything', async () => {
    const r = summarise({ results: [] }, '9.9.9');
    assert.equal(r.changelog, null);
    assert.match(r.verdict, /Nothing on the open web/);
    assert.match(r.verdict, /proves nothing/, 'absence must never be stated as proof');
  });

  await it('mentions that are not release notes are reported as exactly that', async () => {
    const r = summarise({ results: [
      result({ url: 'https://someblog.dev/post', title: 'using x', content: 'we upgraded to 3.1.0 last week' }),
    ] }, '3.1.0');
    assert.equal(r.changelog, null);
    assert.equal(r.mentions, 1);
    assert.match(r.verdict, /none of which is a release note/);
  });

  await it('long result text is trimmed before it reaches a prompt', async () => {
    const r = summarise({ results: [
      result({ url: 'https://github.com/x/y/releases/tag/v1.2.3', title: 'Release 1.2.3', content: 'x '.repeat(5000) + '1.2.3' }),
    ] }, '1.2.3');
    assert.ok(r.changelog.length <= 300, 'an unbounded search result would blow the context window');
  });

  await it('with no key it answers from the recorded corpus and says it is simulated', async () => {
    delete process.env.TAVILY_API_KEY;
    const recorded = { 'a@1.0.1': { changelog: 'Documented.', mentions: 2, verdict: 'Documented by the maintainer.' } };
    const hit = await lookUp('a', '1.0.1', { recorded });
    assert.equal(hit.simulated, true);
    assert.equal(hit.changelog, 'Documented.');

    const miss = await lookUp('b', '9.9.9', { recorded });
    assert.equal(miss.simulated, true);
    assert.equal(miss.changelog, null);
    assert.match(miss.verdict, /Nothing on the open web/);
  });

  await it('a live lookup asks about the package and the version, and never leaks the key into the query', async () => {
    process.env.TAVILY_API_KEY = 'tvly-secret';
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ results: [] }) };
    };
    await lookUp('express-fileupload', '2.1.1', { fetchImpl });
    assert.match(seen.body.query, /express-fileupload/);
    assert.match(seen.body.query, /2\.1\.1/);
    assert.ok(!seen.body.query.includes('tvly-secret'));
    assert.match(seen.headers.authorization, /tvly-secret/);
    delete process.env.TAVILY_API_KEY;
  });

  await it('a failed lookup says so instead of quietly reporting silence', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    await assert.rejects(() => lookUp('x', '1', { fetchImpl }), /tavily 401/,
      'an outage that looks like "no record found" would manufacture findings');
    delete process.env.TAVILY_API_KEY;
  });

  /* ── an empty answer is not a silent web ─────────────────────────────────── */

  const live = (answers) => {
    const calls = [];
    const fetchImpl = async () => {
      const results = answers[Math.min(calls.length, answers.length - 1)];
      calls.push(results.length);
      return { ok: true, json: async () => ({ results }) };
    };
    return { fetchImpl, calls, sleep: async () => {} };
  };

  await it('a search that returns nothing at all is asked again before it is believed', async () => {
    /*
     * Measured against the live API: the same query for a widely-released version came back with
     * zero results in one run of three. Here, "nothing on the web mentions this" is EVIDENCE — so a
     * flaky empty answer taken at face value is evidence manufactured against an innocent package.
     */
    const prev = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test';
    try {
      const t = live([[], [result({ title: 'ms 2.1.3 release notes', url: 'https://github.com/vercel/ms/releases', content: '2.1.3' })]]);
      const r = await lookUp('ms', '2.1.3', t);
      assert.equal(t.calls.length, 2, 'an empty answer was believed on the first try');
      assert.equal(r.searchFailed, false);
      assert.ok(r.mentions >= 1);
    } finally {
      process.env.TAVILY_API_KEY = prev;
    }
  });

  await it('a search that stays empty says the SEARCH failed, which is no evidence either way', async () => {
    const prev = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test';
    try {
      const t = live([[]]);
      const r = await lookUp('ms', '2.1.3', t);
      assert.equal(t.calls.length, 3);
      assert.equal(r.searchFailed, true);
      assert.match(r.verdict, /search that did not work/);
      assert.doesNotMatch(r.verdict, /Nothing on the open web mentions/, 'an outage was reported as a silent web');
    } finally {
      process.env.TAVILY_API_KEY = prev;
    }
  });

  await it('results that exist but do not mention this version ARE the silent web — still evidence', async () => {
    const prev = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test';
    try {
      const t = live([[result({ title: 'ms is a tiny time library', content: 'about version 2.0.0' })]]);
      const r = await lookUp('ms', '9.9.9', t);
      assert.equal(t.calls.length, 1, 'a non-empty answer was retried');
      assert.equal(r.searchFailed, false);
      assert.equal(r.mentions, 0);
      assert.match(r.verdict, /Nothing on the open web mentions/);
    } finally {
      process.env.TAVILY_API_KEY = prev;
    }
  });

  await it('the judge is told about an advisory, and told apart a failed search from a silent web', () => {
    /*
     * The prompt had two branches: a changelog, or "the open web says nothing". An advisory for this
     * exact version — the strongest evidence the lookup can return — fell into the second, so the
     * model was told the web was silent at the one moment it was shouting.
     */
    const { buildPrompt } = require('../judge/prompt');
    const ch = { added: [], removed: [] };
    const d = { pkg: 'p', from: '1.0.0', to: '1.0.1', strategy: 'nodert', severity: 'alarming', reasons: [],
      canSee: {}, net: ch, dns: ch, fs: ch, env: ch, proc: ch, exec: ch };
    const text = (rec) => JSON.stringify(buildPrompt(d, rec));

    const withAdvisory = text({ advisory: 'GHSA-1234: this version exfiltrates tokens' });
    assert.match(withAdvisory, /A security advisory mentions this version: GHSA-1234/);
    assert.doesNotMatch(withAdvisory, /says nothing about this version/, 'an advisory was reported as silence');

    const failed = text({ searchFailed: true });
    assert.match(failed, /search did not work/);
    assert.doesNotMatch(failed, /says nothing about this version/, 'a failed search was reported as silence');

    assert.match(text({}), /says nothing about this version/);
  });

  await it('every verdict is a sentence a human can act on', async () => {
    for (const f of [
      { changelog: 'x', advisory: null, mentions: 1 },
      { changelog: null, advisory: 'x', mentions: 1 },
      { changelog: null, advisory: null, mentions: 3 },
      { changelog: null, advisory: null, mentions: 0 },
    ]) {
      const v = verdictFor(f);
      assert.match(v, /^[A-Z].*\.$/s, `not a sentence: ${v}`);
    }
  });

  console.log(`\n${passed} passed`);
})();
