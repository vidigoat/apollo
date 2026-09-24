/**
 * Can every rule in this file actually fire?
 *
 *   node differ/reachability.test.js
 *
 * `severityOf` is a ladder of early returns. That shape is readable and it has one failure mode
 * that reads as the opposite of a bug: a rule sitting below a return that always precedes it. It
 * looks like coverage. It reviews like coverage. It never runs.
 *
 * This file had one. `minor` carried `if (d.dns.added.length) reasons.push('resolves a name…')`,
 * and reaching `minor` at all means the `notable` block returned nothing — which it only does when
 * `dns.added` is empty. The rule could not fire under any input, and nobody noticed, because the
 * same sentence is produced one rung up and so appeared in the output of real runs.
 *
 * ── Why this is worth a test file of its own ────────────────────────────────
 *
 * These sentences are the product. They are what the wall prints next to a package, what the judge
 * is handed as evidence, and what somebody reads before deciding whether to hold a deployment. A
 * sentence the code can never say is not untidiness — it is a claim about what the tool detects
 * that is false, written in a form that reads as true to every reviewer.
 *
 * ── Method ──────────────────────────────────────────────────────────────────
 *
 * Exhaustive, not sampled. Every channel gets its plausible variants — nothing, something
 * innocuous, something sensitive — and the cross product goes through the real `severityOf`. There
 * are a few hundred combinations, which is small enough to walk on every run and large enough to
 * be the whole input space, because the rules only ever ask whether a channel is non-empty and
 * whether it matches one of three patterns.
 *
 * What comes back is the set of (severity, sentence) pairs the code can produce. That set is
 * asserted whole: a rule that stops firing fails, and a NEW rule fails too, which is deliberate.
 * Adding a sentence the product can say should be a decision somebody makes on purpose.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { severityOf } = require('./diff');

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

/**
 * Every shape a channel can take, as far as the rules can tell them apart.
 *
 * The rules ask two questions of a channel — is it empty, and does anything in it match a pattern —
 * so three variants per channel covers the space: absent, present and ordinary, present and the
 * thing a rule is watching for.
 */
const VARIANTS = {
  net: [[], [{ host: 'a.example', port: 443, proto: 'tls' }]],
  dns: [[], ['a.example']],
  // A channel can also change by losing something — a write that stopped is its own rule.
  fs: [[], [{ op: 'write', path: '/tmp/x' }], { removed: [{ op: 'delete', path: '/tmp/x' }] }],
  env: [[], ['NO_COLOR'], ['AWS_SECRET_ACCESS_KEY']],
  proc: [[], [{ argv: ['ls'] }], [{ argv: ['sh', '-c', 'x'] }]],
  exec: [[], [{ how: 'atob', sample: 'x' }], [{ how: 'Function', sample: 'x' }]],
};

/** Counts and lists vary; the rule they came from does not. */
const shape = (reason) => reason.replace(/\b\d+\b/g, 'N').replace(/\s*\(.*\)$/, ' (…)');

function walk() {
  const keys = Object.keys(VARIANTS);
  const produced = new Set();
  const levels = new Set();
  let combinations = 0;

  const recurse = (i, acc) => {
    if (i === keys.length) {
      combinations++;
      const { level, reasons } = severityOf(acc);
      levels.add(level);
      // Both directions matter: "the wrong sentence at the right severity" is as wrong as a
      // sentence that never appears, because severity is what decides whether anyone looks.
      reasons.forEach((r) => produced.add(`${level} :: ${shape(r)}`));
      return;
    }
    for (const v of VARIANTS[keys[i]]) {
      const part = Array.isArray(v) ? { added: v, removed: [] } : { added: [], removed: v.removed };
      recurse(i + 1, { ...acc, [keys[i]]: part });
    }
  };

  recurse(0, {});
  return { produced, levels, combinations };
}

console.log('severity rules — reachability');

const { produced, levels, combinations } = walk();

/**
 * Everything the product is allowed to say, and the severity it says it at.
 *
 * Changing this list is changing what the tool claims to detect. It should be as hard as editing
 * the rules, which is the point of writing it down here rather than deriving it.
 */
const ALLOWED = [
  'alarming :: reads a credential it did not read before',
  'alarming :: spawns a shell or a downloader it did not spawn before',
  'alarming :: builds and runs code that did not exist in the source (…)',
  'notable :: talks to N destination it did not talk to before',
  'notable :: resolves a name it did not resolve before',
  'minor :: writes somewhere it did not write before',
  'minor :: stopped writing or deleting somewhere it did before',
  'minor :: spawns a process it did not spawn before',
  'minor :: reads N environment variable it did not read before',
  'minor :: decodes something it did not decode before',
];

it('the walk is exhaustive enough to be evidence', () => {
  const expected = Object.values(VARIANTS).reduce((n, v) => n * v.length, 1);
  assert.equal(combinations, expected, 'the walk did not visit the whole cross product');
  assert.ok(combinations > 100, `${combinations} combinations is not a space, it is a sample`);
});

it('every rule fires for some input', () => {
  const dead = ALLOWED.filter((a) => !produced.has(a));
  assert.deepEqual(dead, [],
    `these rules are written but can never fire — an early return above them always wins:\n         ${dead.join('\n         ')}`);
});

it('no rule fires that is not on the list', () => {
  const surprise = [...produced].filter((p) => !ALLOWED.includes(p));
  assert.deepEqual(surprise, [],
    `the product can now say something nobody declared:\n         ${surprise.join('\n         ')}`);
});

it('the same sentence is not said at two different severities', () => {
  // The bug that started this file. The `minor` DNS rule was dead, and it was invisible precisely
  // because the identical sentence appears at `notable` — so the string turned up in real output
  // and every eye slid past it. A sentence that can arrive at two severities cannot be read as
  // evidence of either.
  const bySentence = new Map();
  for (const entry of produced) {
    const [level, sentence] = entry.split(' :: ');
    bySentence.set(sentence, [...(bySentence.get(sentence) || []), level]);
  }
  const ambiguous = [...bySentence].filter(([, ls]) => new Set(ls).size > 1);
  assert.deepEqual(ambiguous, [],
    `ambiguous: ${ambiguous.map(([s, ls]) => `"${s}" at ${ls.join(' and ')}`).join(', ')}`);
});

it('every severity level the schema names is reachable', () => {
  for (const level of ['none', 'minor', 'notable', 'alarming']) {
    assert.ok(levels.has(level), `nothing in the input space produces severity "${level}"`);
  }
});

it('every sentence in the source is one the walk produced', () => {
  // Catches the other direction: a `reasons.push` added to the file that no input can reach. The
  // string literal is in the source, so a grep for the sentence finds it and it reads as supported.
  const src = fs.readFileSync(path.join(__dirname, 'diff.js'), 'utf8');
  // Ignore anything inside a block comment — the dead rule this file removed is DESCRIBED there,
  // and a rule quoted in its own obituary must not be mistaken for a live one.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = [...code.matchAll(/reasons\.push\(\s*[`'"]([^`'"$]{10,})/g)].map((m) => m[1].trim());

  assert.ok(literals.length >= 6, `only found ${literals.length} rule sentences — the matcher has stopped working`);
  const said = [...produced].map((p) => p.split(' :: ')[1]);
  for (const literal of literals) {
    assert.ok(said.some((s) => s.startsWith(literal.slice(0, 20))),
      `"${literal}" is written in diff.js and no input produces it`);
  }
});

it('a quiet diff says nothing at all', () => {
  const { level, reasons } = severityOf({});
  assert.equal(level, 'none');
  assert.deepEqual(reasons, [], 'a package that did nothing was given something to explain');
});

console.log(`\n${passed} passed  ·  ${combinations} channel combinations walked, ${produced.size} rules reachable`);
