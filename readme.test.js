/**
 * The README has to still be true.
 *
 * Four figures in this project have gone stale in prose while staying correct in code: the tree
 * size when a fourth plant was added, the model-call count when that plant reached the judge, the
 * check count twice, and — with some irony — the example inside the rule that forbids exactly this.
 *
 * Every one was caught by a person reading carefully, which is not a process. This is:
 * `scripts/check-readme.js` runs the commands, scrapes the figures out of their real output, and
 * fails if the README no longer contains them.
 *
 * Deliberately narrow. It checks the handful of numbers a reader would act on, not every digit,
 * because a check that fires on a version string inside a code fence is a check somebody deletes.
 *
 * Run: node readme.test.js
 */

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');

console.log('readme');

it('every figure it quotes is one a command still produces', () => {
  // The whole check, delegated — so there is one implementation and `npm run check-readme` and the
  // suite can never disagree about what "still true" means.
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'check-readme.js')],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`the README has drifted from the commands:\n${e.stdout || e.message}`);
  }
  assert.match(out, /Every figure these documents quote/);
});

it('it does not promise a command that does not exist', () => {
  // A README telling somebody to run something that is not there is worse than a wrong number:
  // it is the first thing they try.
  const scripts = require('./package.json').scripts;
  const promised = [...README.matchAll(/npm run ([a-z-]+)/g)].map((m) => m[1]);
  const missing = [...new Set(promised)].filter((s) => !scripts[s]);
  assert.deepEqual(missing, [], `README promises: ${missing.map((m) => `npm run ${m}`).join(', ')}`);
});

it('every file it points at is really there', () => {
  const linked = [...README.matchAll(/\]\((docs\/[^)#]+|[a-z]+\/[a-z-]+\.js|[a-z-]+\.js)\)/g)].map((m) => m[1]);
  const missing = [...new Set(linked)].filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.deepEqual(missing, [], `README links to: ${missing.join(', ')}`);
});

it('it still states the limitation it is easiest to quietly drop', () => {
  // The claim this project would be most tempted to soften: it compares you to your PREVIOUS
  // version, not to "good". A package malicious in both is invisible, and a README that stopped
  // saying so would be overselling in the one place it matters.
  assert.match(README, /already malicious in the version you had/i);
  assert.match(README, /not a clean-room audit/i);
});

console.log(`\n${passed} passed`);
