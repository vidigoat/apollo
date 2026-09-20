/**
 * The Nemotron client.
 *
 * judge.test.js exercises the pipeline with stub models, which means the one thing it never checks
 * is the request this file actually sends.
 *
 * That request HAS now been answered by a real server — 2026-09-20 — and the answer corrected three
 * things these stubs could never have caught: all three model ids were invented and 404'd, and
 * Nemotron 3 turned out to be a reasoning model whose working-out is billed before its answer, so a
 * max_tokens sized for the answer returns empty content with `finish_reason: "stop"`.
 *
 * Which is the argument for `npm run preflight` existing alongside this file rather than instead of
 * it. Stubs check the shape of the request; only a real server checks whether the request is about
 * anything. This file still earns its place — the cost arithmetic below decides a number printed on
 * the page, and that arithmetic should not need a network to verify.
 *
 * `npm run preflight` checks the half that needs a key. This checks the half that does not.
 *
 * Run: node judge/nemotron.test.js
 */

const assert = require('node:assert');
const { complete, MODELS, RATES, costOf, hasKey } = require('./nemotron');
const { Budget } = require('./budget');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A ledger of its own, per test.
 *
 * The first run of this file spent $0.50 of imaginary money into the REAL ledger and then, quite
 * correctly, refused to go on. The guard was right and the test was wrong: a suite that writes to
 * the same file as a live run can exhaust a real budget with stub money.
 */
const isolated = () =>
  new Budget({ ceiling: 10, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'spend.json') });

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

const withKey = async (fn) => {
  const had = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = 'test-key';
  const saved = globalThis.fetch;
  try {
    return await fn((impl) => { globalThis.fetch = impl; });
  } finally {
    globalThis.fetch = saved;
    if (had === undefined) delete process.env.NEBIUS_API_KEY;
    else process.env.NEBIUS_API_KEY = had;
  }
};

const reply = (content, usage) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }], usage }),
  text: async () => '',
});

(async () => {
  console.log('nemotron client');

  await it('three distinct models, because they are three different jobs', () => {
    const ids = Object.values(MODELS);
    assert.equal(new Set(ids).size, 3, 'two roles share a model — the triage/judge/veto split is gone');
    ids.forEach((id) => assert.ok(RATES[id], `${id} has no published rate, so the bill will read $0`));
  });

  await it('the cheap model is actually cheaper than the expensive one', () => {
    assert.ok(RATES[MODELS.triage].in < RATES[MODELS.judge].in,
      'if triage is not cheaper, the whole triage design is pointless');
    assert.ok(RATES[MODELS.second].in < RATES[MODELS.judge].in);
  });

  await it('cost is computed from tokens, per million, input and output separately', () => {
    const m = MODELS.judge;
    const { in: i, out: o } = RATES[m];
    assert.equal(costOf(m, { prompt_tokens: 1e6, completion_tokens: 0 }), i);
    assert.equal(costOf(m, { prompt_tokens: 0, completion_tokens: 1e6 }), o);
    assert.equal(costOf(m, { prompt_tokens: 1e6, completion_tokens: 1e6 }), Number((i + o).toFixed(6)));
  });

  await it('a missing or malformed usage block costs zero, not NaN', () => {
    // A NaN would propagate into the total and render as "$NaN" on the page.
    for (const usage of [undefined, null, {}, { prompt_tokens: null }]) {
      const c = costOf(MODELS.judge, usage);
      assert.ok(Number.isFinite(c), `usage ${JSON.stringify(usage)} produced ${c}`);
      assert.equal(c, 0);
    }
    assert.equal(costOf('a-model-we-have-no-rate-for', { prompt_tokens: 1e6 }), 0);
  });

  await it('sends the request the API actually expects', async () => {
    await withKey(async (setFetch) => {
      let seen;
      setFetch(async (url, opts) => {
        seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
        return reply('{}', { prompt_tokens: 10, completion_tokens: 5 });
      });
      await complete({ model: MODELS.judge, system: 'S', user: 'U', maxTokens: 123, budget: isolated() });

      assert.match(seen.url, /chat\/completions$/);
      assert.match(seen.headers.authorization, /^Bearer test-key$/);
      assert.equal(seen.body.model, MODELS.judge);
      assert.equal(seen.body.max_tokens, 123);
      assert.equal(seen.body.temperature, 0, 'a judgement that changes between runs cannot be checked');
      assert.deepEqual(seen.body.response_format, { type: 'json_object' },
        'without this the model is free to reply in prose, and the verdict parser drops it');
      assert.deepEqual(seen.body.messages, [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ]);
    });
  });

  await it('reads the reply out of the shape the API returns', async () => {
    await withKey(async (setFetch) => {
      setFetch(async () => reply('{"meaning":"x"}', { prompt_tokens: 2e5, completion_tokens: 1e5 }));
      const r = await complete({ model: MODELS.judge, system: 's', user: 'u', budget: isolated() });
      assert.equal(r.text, '{"meaning":"x"}');
      assert.equal(r.simulated, false, 'a live call must never be labelled simulated');
      assert.ok(r.costUsd > 0, 'a live call that costs nothing means the usage block was not read');
    });
  });

  await it('a reply with no choices is empty text, not a crash', async () => {
    await withKey(async (setFetch) => {
      setFetch(async () => ({ ok: true, json: async () => ({}), text: async () => '' }));
      const r = await complete({ model: MODELS.judge, system: 's', user: 'u', budget: isolated() });
      assert.equal(r.text, '', 'an unexpected reply shape must degrade to "no verdict", not throw');
    });
  });

  await it('an API error says which status and what came back', async () => {
    await withKey(async (setFetch) => {
      setFetch(async () => ({ ok: false, status: 429, text: async () => 'rate limited, slow down' }));
      await assert.rejects(
        () => complete({ model: MODELS.judge, system: 's', user: 'u', budget: isolated() }),
        /nemotron 429.*rate limited/,
        'an outage must be loud — a silent one would look like "no finding"'
      );
    });
  });

  await it('with no key it answers locally, and never claims the answer is live', async () => {
    const had = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    assert.equal(hasKey(), false);
    const r = await complete({
      model: MODELS.judge,
      system: 's',
      user: 'NOW READS ENV    AWS_SECRET_ACCESS_KEY\nNOW CONNECTS TO  evil.example:443',
    });
    assert.equal(r.simulated, true);
    assert.equal(r.costUsd, 0);
    const v = JSON.parse(r.text);
    assert.match(v.meaning, /AWS_SECRET_ACCESS_KEY/);
    assert.equal(v.worthWaking, true, 'credential plus a new destination is the one shape it must catch');
    if (had !== undefined) process.env.NEBIUS_API_KEY = had;
  });

  await it('the local stand-in never reports "no difference" for a diff that has one', async () => {
    delete process.env.NEBIUS_API_KEY;
    const evidence = [
      'NOW READS ENV    NO_COLOR',
      'NOW CONNECTS TO  a.example:443',
      'NOW SPAWNS       sh -c x',
      'NOW TOUCHES FILE write /app/x',
    ];
    for (const line of evidence) {
      const r = await complete({ model: MODELS.triage, system: 's', user: line });
      const v = JSON.parse(r.text);
      assert.doesNotMatch(v.meaning, /No difference/,
        `"${line}" was described as no difference — this is the picocolors bug again`);
    }
  });

  console.log(`\n${passed} passed`);
})();
