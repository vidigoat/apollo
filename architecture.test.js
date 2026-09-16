/**
 * The guarantee has to cover the code that ships.
 *
 * `runPair.js` is where the central claim of this project lives: both twins fork from ONE
 * checkpoint at the same instant, and every branch is released whatever happens. `runPair.test.js`
 * proves both — by wrapping `adapter.fork` and asserting a single checkpoint, and by killing the
 * adapter mid-run and asserting nothing leaked.
 *
 * For a while that proof covered one caller. The survey, the lockfile runner, the real-registry
 * script and the server's live route had each grown their own `fork(checkpoint, 2)` … `finally
 * discard` sequence, which meant the tested guarantee and the shipping path were different code.
 * Nothing was wrong with any of them. That is not the point: a copy that happens to be correct
 * today is a copy that can stop being correct without a test noticing.
 *
 * So this is a test about the shape of the repository rather than about behaviour.
 *
 * Run: node architecture.test.js
 */

const assert = require('node:assert');
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

const ROOT = __dirname;
const SKIP = new Set(['node_modules', '.git', 'docs', 'public']);

function sources(dir = ROOT, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(full);
  }
  return found;
}

const FILES = sources().map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

/**
 * One deliberate exception, named rather than worked around.
 *
 * `scripts/preflight.js` calls fork and discard directly because probing them is the whole point of
 * it: its job is to find out whether a real Sandboxes account can boot, fork and release at all,
 * before anything depends on that. Routing it through runPair would mean the check could only fail
 * in the same way the thing it is checking does.
 */
const ALLOWED_TO_FORK_DIRECTLY = new Set(['scripts/preflight.js']);

console.log('architecture');

it('only runPair forks a pair of twins', () => {
  // The whole comparison rests on both versions starting from the same instant. Anywhere else that
  // forks two branches is a second, untested implementation of that.
  const offenders = FILES
    .filter((f) => f.rel !== 'runPair.js' && !ALLOWED_TO_FORK_DIRECTLY.has(f.rel))
    .filter((f) => /\.fork\(\s*\w+\s*,\s*2\s*\)/.test(f.text))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], `these fork their own twins instead of calling runPair: ${offenders.join(', ')}`);
});

it('only runPair is responsible for giving branches back', () => {
  // A caller that discards is a caller that can forget to, and "forgot on the error path" is the
  // version of that bug nobody sees until a run dies halfway through.
  const offenders = FILES
    .filter((f) => f.rel !== 'runPair.js' && !f.rel.startsWith('adapters/') && !ALLOWED_TO_FORK_DIRECTLY.has(f.rel))
    .filter((f) => /\.discard\(/.test(f.text))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], `these release branches themselves: ${offenders.join(', ')}`);
});

it('runPair still does the two things it exists to do', () => {
  // Cheap insurance against this test passing because runPair was gutted.
  const src = FILES.find((f) => f.rel === 'runPair.js').text;
  assert.match(src, /fork\(checkpoint, 2\)/, 'runPair no longer forks two twins from one checkpoint');
  assert.match(src, /finally/, 'runPair no longer releases branches unconditionally');
  assert.match(src, /discard/, 'runPair no longer discards anything');
});

it('every runner reaches the registry through the same observer', () => {
  // Two ways of installing-and-importing a package would be two definitions of what "the same
  // starting state" means.
  const callers = FILES.filter((f) => /observePackage\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(callers.sort(), ['observe/index.js', 'runPair.js'],
    `observePackage is called from: ${callers.join(', ')}`);
});

it('nothing outside the differ decides how serious a change is', () => {
  // Severity is arithmetic, in one file anyone can read. A second opinion about it hiding in a
  // script would make that claim false in the exact place a reviewer would not look.
  const offenders = FILES
    .filter((f) => !f.rel.startsWith('differ/'))
    .filter((f) => /severity\s*=\s*['"]|severity:\s*['"](alarming|notable|minor)['"]/.test(f.text))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], `these assign a severity of their own: ${offenders.join(', ')}`);
});

it('the exception list is short, and every file on it still exists', () => {
  // An allow-list is how a rule dies. Keeping it visible and checked is the cheapest defence.
  assert.ok(ALLOWED_TO_FORK_DIRECTLY.size <= 2, 'the exception list is growing; the rule is dissolving');
  ALLOWED_TO_FORK_DIRECTLY.forEach((rel) =>
    assert.ok(FILES.some((f) => f.rel === rel), `${rel} is excused from a rule it no longer needs excusing from`));
});

console.log(`\n${passed} passed`);
