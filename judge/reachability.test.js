/**
 * Can the judge actually reach every conclusion it can print?
 *
 *   node judge/reachability.test.js
 *
 * `judgeOne` is a three-tier cascade with nine different sentences at the end of it, and those
 * sentences are what a person reads at the top of a report before deciding whether to hold a
 * deployment. They are the output of the product.
 *
 * A cascade of early returns hides dead paths perfectly: a branch below a return that always
 * precedes it reads as coverage, reviews as coverage, and never runs. Two were found in this
 * project's sibling repositories on one afternoon, and one in `differ/diff.js` here — the `minor`
 * DNS rule, invisible because the identical sentence is produced one rung up.
 *
 * `judge.test.js` drives this cascade with stub models to check that the tiers behave. This asks a
 * different question, and asks it exhaustively: over every combination of what the rules decided
 * and what each model said, which of the nine sentences can the code actually produce?
 *
 * The models are stubs, and that is the point — the question is about control flow, not about what
 * Nemotron thinks. It needs no key and costs nothing.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { judgeOne } = require('./index');
const { MODELS } = require('./nemotron');
const { Budget } = require('./budget');

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

/** Its own ledger, because a suite that writes to the live one can exhaust a real budget. */
const isolated = () =>
  new Budget({ ceiling: 10, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'spend.json') });

/** A diff of a given severity, with whatever evidence that severity implies. */
const diffOf = (severity, { changed = true, env = [], net = [], exec = [], proc = [] } = {}) => ({
  pkg: 'example', from: '1.0.0', to: '1.0.1', strategy: 'nodert',
  changed, severity,
  net: { added: net, removed: [] },
  dns: { added: [], removed: [] },
  fs: { added: [], removed: [] },
  env: { added: env, removed: [] },
  proc: { added: proc, removed: [] },
  exec: { added: exec, removed: [] },
  reasons: ['for the prompt'],
  timing: { importDeltaMs: 0 },
  canSee: { net: true, dns: true, fs: true, env: true, proc: true, exec: true },
});

/** A stubbed model, answering differently per tier so each branch can be steered. */
const answering = (byModel) => async ({ model }) => ({
  model,
  text: byModel[model] === null ? 'not a verdict at all' : JSON.stringify(byModel[model]),
  costUsd: 0,
  simulated: true,
});

/*
 * `confidence` is not decoration. parseVerdict rejects a verdict without one of 'high'|'medium'
 * |'low', which is correct — a model that cannot say how sure it is has not answered the question —
 * and a stub missing it is silently treated as garbage, so every branch below the first collapses.
 * The first draft of this file did exactly that and reported five conclusions unreachable.
 */
const SAYS_WAKE = { meaning: 'x', worthWaking: true, explained: false, confidence: 'high' };
const SAYS_SLEEP = { meaning: 'x', worthWaking: false, explained: false, confidence: 'low' };
const SAYS_EXPLAINED = { meaning: 'x', worthWaking: true, explained: true, confidence: 'medium' };

/**
 * Everything the judge is allowed to conclude.
 *
 * Changing this list changes what the product can say to somebody deciding whether to hold a
 * release. It should be as deliberate as changing the cascade.
 */
const ALLOWED = [
  'no behavioural change',
  'triage saw nothing that needs a human tonight',
  'triage returned nothing usable',
  'the model returned something that was not a verdict; falling back to the rules',
  'two models, independently, read this as …',
  'the second model did not agree — this needs a human, not an alert',
  'the public record accounts for this behaviour',
  'flagged for a human; not accused',
];

const shape = (reason) => reason.replace(/read this as .*/, 'read this as …');

(async () => {
  console.log('judge cascade — reachability');

  const produced = new Map();
  let runs = 0;

  const SEVERITIES = ['none', 'minor', 'notable', 'alarming'];
  const VERDICTS = { wake: SAYS_WAKE, sleep: SAYS_SLEEP, explained: SAYS_EXPLAINED, garbage: null };

  for (const severity of SEVERITIES) {
    for (const changed of [true, false]) {
      for (const [tName, triage] of Object.entries(VERDICTS)) {
        for (const [jName, judge] of Object.entries(VERDICTS)) {
          for (const [sName, second] of Object.entries(VERDICTS)) {
            runs++;
            const d = diffOf(severity, {
              changed,
              // Alarming diffs carry the evidence that makes them alarming, so that the accusation
              // sentence has something real to name.
              env: severity === 'alarming' ? ['AWS_SECRET_ACCESS_KEY'] : [],
              net: severity === 'alarming' ? [{ host: 'a.example', port: 443, proto: 'tls' }] : [],
            });
            const r = await judgeOne(d, null, {
              complete: answering({ [MODELS.triage]: triage, [MODELS.judge]: judge, [MODELS.second]: second }),
              budget: isolated(),
            });
            const key = shape(r.reason);
            if (!produced.has(key)) produced.set(key, `${severity}/changed=${changed}/${tName}/${jName}/${sName}`);
          }
        }
      }
    }
  }

  await it('the walk is a space, not a sample', () => {
    assert.equal(runs, SEVERITIES.length * 2 * 4 * 4 * 4, 'the cross product was not fully walked');
  });

  await it('every conclusion the judge can print is reachable', () => {
    const dead = ALLOWED.filter((a) => !produced.has(a));
    assert.deepEqual(dead, [],
      `written but unreachable — a return above always wins:\n         ${dead.join('\n         ')}`);
  });

  await it('the judge cannot conclude something nobody declared', () => {
    const surprise = [...produced.keys()].filter((p) => !ALLOWED.includes(p));
    assert.deepEqual(surprise, [],
      `the report can now say something undeclared:\n         ${surprise.join('\n         ')}`);
  });

  await it('an accusation requires two models and evidence to name', () => {
    // The strongest sentence the product prints. It should be hard to reach, and reachable only
    // through the one door: alarming, both models awake, neither explaining it away.
    const contexts = [...produced].filter(([k]) => k.startsWith('two models'));
    assert.equal(contexts.length, 1, 'the accusation sentence is unreachable');
    for (const [, ctx] of contexts) {
      assert.ok(ctx.startsWith('alarming/'), `an accusation was reachable at ${ctx.split('/')[0]} severity`);
    }
  });

  await it('a model that says nothing usable never produces an accusation', async () => {
    // Failing open here would mean a garbled reply reading as agreement.
    for (const [tier, answers] of Object.entries({
      'judge garbled': { [MODELS.triage]: SAYS_WAKE, [MODELS.judge]: null, [MODELS.second]: SAYS_WAKE },
      'second garbled': { [MODELS.triage]: SAYS_WAKE, [MODELS.judge]: SAYS_WAKE, [MODELS.second]: null },
    })) {
      const r = await judgeOne(diffOf('alarming', { env: ['AWS_SECRET_ACCESS_KEY'] }), null, {
        complete: answering(answers),
        budget: isolated(),
      });
      assert.equal(r.accused, false, `${tier}: an unparseable reply was counted as agreement`);
    }
  });

  await it('the rules keep the severity whatever the models say', async () => {
    // The model explains; it never escalates. A model that could move severity could also lower it.
    for (const severity of SEVERITIES) {
      const r = await judgeOne(diffOf(severity), null, {
        complete: answering({ [MODELS.triage]: SAYS_WAKE, [MODELS.judge]: SAYS_WAKE, [MODELS.second]: SAYS_WAKE }),
        budget: isolated(),
      });
      assert.equal(r.severity, severity, 'a model moved a severity the rules decided');
    }
  });

  await it('nothing is spent on a package that did not change', async () => {
    const r = await judgeOne(diffOf('none', { changed: false }), null, {
      complete: async () => { throw new Error('a model was called on a package that did nothing'); },
      budget: isolated(),
    });
    assert.equal(r.costUsd, 0);
    assert.equal(r.judged, false);
  });

  console.log(`\n${passed} passed  ·  ${runs} cascades walked, ${produced.size} conclusions reachable`);
})();
