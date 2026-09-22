/**
 * The judgement cache.
 *
 *   node judge/cache.test.js
 *
 * This exists because of a bill. Every load of `/api/run` re-judged the same fifteen packages, so
 * an afternoon of screenshots put 145 model calls through a live key — and on the public demo URL
 * the Nebius submission requires, a judge refreshing the page ten times would pay for ninety calls
 * to be told the same thing ten times. A project whose entire argument is "do not pay a model to
 * re-read evidence it has already read" was doing exactly that.
 *
 * Nothing here touches a network or a real cache directory.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JudgementCache, keyFor, PROMPT_VERSION } = require('./cache');

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

const fresh = () => new JudgementCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jcache-')) });

const MODELS = { triage: 'a/nano', judge: 'a/ultra', second: 'a/super' };

const diffOf = (over = {}) => ({
  pkg: 'example', from: '1.0.0', to: '1.0.1', strategy: 'nodert',
  changed: true, severity: 'alarming', reasons: ['reads a credential it did not read before'],
  net: { added: [{ host: 'evil.example', port: 443, proto: 'tls' }], removed: [] },
  dns: { added: [], removed: [] },
  fs: { added: [], removed: [] },
  env: { added: ['AWS_SECRET_ACCESS_KEY'], removed: [] },
  proc: { added: [], removed: [] },
  exec: { added: [], removed: [] },
  ...over,
});

const judgement = (over = {}) => ({
  pkg: 'example', severity: 'alarming', judged: true, tier: 'judge',
  verdict: { meaning: 'reads a credential', explained: false, worthWaking: true, confidence: 'high', note: '' },
  accused: true, reason: 'two models, independently, read this as credential exfiltration',
  spend: [{ model: 'a/nano', costUsd: 0.0001, simulated: false }],
  costUsd: 0.0001,
  ...over,
});

console.log('judgement cache');

it('a verdict written is a verdict returned, and it says it was cached', () => {
  const c = fresh();
  const job = { diff: diffOf(), models: MODELS, record: null };
  assert.equal(c.get(job), null, 'a cold cache must not invent an answer');

  c.put(job, judgement());
  const hit = c.get(job);
  assert.ok(hit, 'the verdict did not come back');
  assert.equal(hit.accused, true);
  assert.equal(hit.cached, true, 'a caller cannot say "from cache" if the cache does not say so');
});

it('different evidence is a different question', () => {
  const c = fresh();
  c.put({ diff: diffOf(), models: MODELS, record: null }, judgement());

  // One extra host. Same package, same versions — and a verdict about something else.
  const other = diffOf({ net: { added: [{ host: 'other.example', port: 443, proto: 'tls' }], removed: [] } });
  assert.equal(c.get({ diff: other, models: MODELS, record: null }), null,
    'a verdict about one set of evidence was served for another');
});

it('the same evidence in a different order is the same question', () => {
  // Channel contents are sets. Two runs that observed the same things must not pay twice because
  // the observer happened to emit them in a different order.
  const c = fresh();
  const a = diffOf({ env: { added: ['AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN'], removed: [] } });
  const b = diffOf({ env: { added: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'], removed: [] } });
  c.put({ diff: a, models: MODELS, record: null }, judgement());
  assert.ok(c.get({ diff: b, models: MODELS, record: null }), 'ordering alone caused a miss');
});

it('a different model is a different question', () => {
  const c = fresh();
  c.put({ diff: diffOf(), models: MODELS, record: null }, judgement());
  const swapped = { ...MODELS, judge: 'b/something-else' };
  assert.equal(c.get({ diff: diffOf(), models: swapped, record: null }), null,
    'a verdict from one model was served as another model\'s');
});

it('what the open web says is part of the question', () => {
  // "Nothing mentions this version" and "a changelog explains it" are different prompts, and a
  // verdict formed under one must never answer the other.
  const c = fresh();
  c.put({ diff: diffOf(), models: MODELS, record: { verdict: 'nothing on the open web' } }, judgement());
  assert.equal(
    c.get({ diff: diffOf(), models: MODELS, record: { verdict: 'the changelog documents it' } }),
    null,
    'the public record was ignored by the key'
  );
});

it('a new prompt invalidates every old verdict', () => {
  // The prompt was hardened once already, after a live injection talked a model out of a finding.
  // Serving verdicts formed under the old one would have quietly undone that fix.
  const c = fresh();
  const job = { diff: diffOf(), models: MODELS, record: null };
  c.put(job, judgement());

  const file = c.path(keyFor(job));
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  entry.promptVersion = PROMPT_VERSION - 1;
  fs.writeFileSync(file, JSON.stringify(entry));

  assert.equal(c.get(job), null, 'a verdict from an older prompt was served');
});

it('a simulated verdict is never cached', () => {
  // An offline verdict is a stand-in for an answer, not an answer. Freezing one would let a single
  // keyless run poison every keyed run that followed.
  const c = fresh();
  const job = { diff: diffOf(), models: MODELS, record: null };
  c.put(job, judgement({ spend: [{ model: 'a/nano', costUsd: 0, simulated: true }] }));
  assert.equal(c.get(job), null, 'a simulated verdict was written to the cache');
});

it('an unjudged package is never cached', () => {
  const c = fresh();
  const job = { diff: diffOf(), models: MODELS, record: null };
  c.put(job, judgement({ judged: false, spend: [] }));
  assert.equal(c.get(job), null);
});

it('a corrupt entry is a miss, not a crash', () => {
  // A broken cache costs money. It must never cost a run.
  const c = fresh();
  const job = { diff: diffOf(), models: MODELS, record: null };
  c.put(job, judgement());
  fs.writeFileSync(c.path(keyFor(job)), '{ not json');
  assert.equal(c.get(job), null);
});

it('disabled means disabled, in both directions', () => {
  const c = new JudgementCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jcache-')), enabled: false });
  const job = { diff: diffOf(), models: MODELS, record: null };
  c.put(job, judgement());
  assert.equal(c.get(job), null);
});

it('the key is stable across processes', () => {
  // It is a filename. If it moved between runs the cache would never hit, and the only symptom
  // would be a bill.
  const job = { diff: diffOf(), models: MODELS, record: null };
  assert.equal(keyFor(job), keyFor(job));
  assert.match(keyFor(job), /^[0-9a-f]{32}$/);
});

it('two packages with identical evidence do not share one verdict', () => {
  /*
   * This shipped. `tiny-glob` and `lru-memo` both start writing to a cache file, and after
   * normalisation their evidence is byte-identical — so the hosted demo served tiny-glob's verdict
   * as lru-memo's. The row said lru-memo, the object inside said `"pkg": "tiny-glob"`, the model's
   * own reasoning text discussed the other package, and it was counted as a live paid call in
   * `modelCalls` and `modelUsd`.
   *
   * The prompt opens with `Package: ${d.pkg}`. Two names, two questions, two answers.
   */
  const evidence = {
    severity: 'minor',
    reasons: ['writes somewhere it did not write before'],
    strategy: 'nodert',
    fs: { added: [{ op: 'write', path: '/app/·cache/·' }], removed: [] },
    net: { added: [], removed: [] },
    dns: { added: [], removed: [] },
    env: { added: [], removed: [] },
    proc: { added: [], removed: [] },
    exec: { added: [], removed: [] },
  };

  const models = { triage: 'nano', judge: 'ultra', veto: 'super' };
  const a = keyFor({ diff: { ...evidence, pkg: 'tiny-glob' }, models, record: null });
  const b = keyFor({ diff: { ...evidence, pkg: 'lru-memo' }, models, record: null });

  assert.notEqual(a, b, 'two packages with the same evidence still share one cached verdict');

  // And the same package with the same evidence still hits, or the cache has stopped being one.
  const again = keyFor({ diff: { ...evidence, pkg: 'tiny-glob' }, models, record: null });
  assert.equal(a, again, 'the key is not stable for one package');
});

console.log(`\n${passed} passed`);
