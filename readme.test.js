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

it('no document promises a command that does not exist', () => {
  /*
   * The first thing a reviewer tries. A document pointing at a script that is not there costs more
   * trust than a wrong number does.
   *
   * This was the README only, and matched `[a-z-]+` — so it saw neither `npm run mcp:session`,
   * because of the colon, nor `npm run verify-against-pages` in the recording script, because that
   * is a different file. Both were named in documents while one of them was not a script at all,
   * which is exactly what somebody discovers with a camera running.
   */
  const scripts = require('./package.json').scripts;
  /*
   * `NEEDS.md` is kept byte-identical in both repositories on purpose — it is one list of what is
   * owed across both projects — so the commands it names are not all this project's, and it says
   * so on the line. It is the only file exempt, and it is exempt by name rather than by rule.
   */
  const SHARED = 'NEEDS.md';

  const docs = [
    'README.md',
    ...fs.readdirSync(path.join(__dirname, 'docs'))
      .filter((f) => f.endsWith('.md') && f !== SHARED)
      .map((f) => path.join('docs', f)),
  ];

  for (const doc of docs) {
    const text = fs.readFileSync(path.join(__dirname, doc), 'utf8');
    const promised = [...text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(promised)].filter((s) => !scripts[s]);
    assert.deepEqual(missing, [], `${doc} promises: ${missing.map((m) => `npm run ${m}`).join(', ')}`);
  }
});

it('every file it points at is really there', () => {
  const linked = [...README.matchAll(/\]\((docs\/[^)#]+|[a-z]+\/[a-z-]+\.js|[a-z-]+\.js)\)/g)].map((m) => m[1]);
  const missing = [...new Set(linked)].filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.deepEqual(missing, [], `README links to: ${missing.join(', ')}`);
});

it('every relative link in every document resolves FROM THE FILE IT IS IN', () => {
  /*
   * `docs/DEEP-DIVE.md` was the old README, moved into `docs/` when the README was cut down. Its
   * paths came with it: twenty-three links written relative to the repository root, now one
   * directory down, every one of them resolving to `docs/docs/…`. Nine images and the whole
   * reference trail — the architecture, the demo script, the submission, all nine decision records —
   * and on GitHub the page rendered as a column of broken-image icons and dead blue text. The
   * sibling project had the identical fault in the identical file, from the identical edit.
   *
   * The check above reads README.md, so it saw none of it. A relative link is only correct relative
   * to the file that holds it, which is what this checks, for every markdown file here.
   */
  const docs = [
    'README.md',
    ...fs.readdirSync(path.join(__dirname, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join('docs', f)),
  ];

  for (const doc of docs) {
    const text = fs.readFileSync(path.join(__dirname, doc), 'utf8');
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1].split('#')[0])
      .filter((l) => l && !/^(https?:|mailto:)/.test(l));

    const here = path.join(__dirname, path.dirname(doc));
    const missing = [...new Set(links)].filter(
      (l) => !fs.existsSync(path.join(here, decodeURIComponent(l)))
    );
    assert.deepEqual(missing, [], `${doc} links to, and does not reach: ${missing.join(', ')}`);
  }
});

it('it still states the limitation it is easiest to quietly drop', () => {
  // The claim this project would be most tempted to soften: it compares you to your PREVIOUS
  // version, not to "good". A package malicious in both is invisible, and a README that stopped
  // saying so would be overselling in the one place it matters.
  assert.match(README, /already malicious in the version you had/i);
  assert.match(README, /not a clean-room audit/i);
});

it('a claim about an interaction says where the interaction lives', () => {
  /*
   * `docs/SUBMISSION.md` — the document a judge reads — said "Clicking a project gives its packages
   * with a six-slot channel strip". Nothing in the rebuilt site calls `/api/project` at all: the
   * drill-down was lost in a redesign and the sentence describing it was not. A promise about an
   * interaction is the easiest kind to leave behind, because nothing about the code changes shape
   * when it goes, and no test anywhere had a reason to notice.
   *
   * The first version of this check asked whether the site handled ANY click. It does — there are
   * tabs — so reverting the fix sailed through it. The rule that actually holds is narrower and
   * more useful: a sentence describing something you do by clicking has to say WHERE it lives — an
   * endpoint, or a command — so a reader can go and check rather than taking it on trust. That is
   * what the corrected sentence does, and it is what the old one did not.
   */
  const docs = ['README.md', ...fs.readdirSync(path.join(__dirname, 'docs'))
    .filter((f) => f.endsWith('.md')).map((f) => path.join('docs', f))];

  /*
   * "Where it lives" is an endpoint, a command, a local address, or — for a click on somebody
   * else's website, which `docs/NEEDS.md` is full of — a URL. All four let a reader go and look.
   */
  const SAYS_WHERE = /`\/api\/|npm run |node scripts\/|`GET |`POST |localhost:|https?:\/\//;

  for (const doc of docs) {
    const text = fs.readFileSync(path.join(__dirname, doc), 'utf8');

    /*
     * Paragraphs, with a heading glued to the one beneath it.
     *
     * A sentence may say what the thing is and the next one where it lives, and a markdown heading
     * is its own paragraph — so `### Click "Request beta access"` was judged alone, with the URL
     * that answers it sitting one blank line away.
     */
    const paras = [];
    for (const raw of text.split(/\n\s*\n/)) {
      if (paras.length && /^#{1,6}\s/.test(paras[paras.length - 1].trim())) {
        paras[paras.length - 1] += `\n${raw}`;
      } else {
        paras.push(raw);
      }
    }

    for (const para of paras) {
      if (!/\bclick(ing|s)?\b/i.test(para)) continue;
      assert.ok(
        SAYS_WHERE.test(para),
        `${doc} describes something you do by clicking and never says where it lives:\n` +
          `        "${para.replace(/\s+/g, ' ').trim().slice(0, 120)}…"`
      );
    }
  }
});

it('every file the judging map points at is really there', () => {
  /*
   * This one rotted silently and badly. `docs/JUDGING.md` is the first thing a reviewer opens, and
   * it pointed at `orchestrator.js`, `orchestrator.test.js`, `scenarios/index.js` and a
   * `contree.js` that had all been renamed or removed in an earlier restructure — four dead ends in
   * the first two tables. A map to files that do not exist is worse than no map: it spends a
   * reviewer's goodwill before they have seen anything.
   *
   * README.md is checked the same way elsewhere in this file. There was no reason the document
   * written FOR reviewers should have been the unchecked one.
   */
  const map = fs.readFileSync(path.join(__dirname, 'docs', 'JUDGING.md'), 'utf8');
  const named = [...map.matchAll(/`([a-zA-Z][a-zA-Z0-9_/.-]*\.(?:js|md|json|css|html))`/g)]
    .map((m) => m[1]);

  const missing = [...new Set(named)].filter(
    (f) => !fs.existsSync(path.join(__dirname, f)) && !fs.existsSync(path.join(__dirname, 'docs', f))
  );
  assert.deepEqual(missing, [], `docs/JUDGING.md points at files that do not exist: ${missing.join(', ')}`);
});

console.log(`\n${passed} passed`);
