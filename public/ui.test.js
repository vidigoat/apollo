/**
 * The interface, tested.
 *
 * A demo that breaks on stage is worth nothing, and the usual way a page like this breaks is
 * quiet: a renamed id, a class that was never styled, a field the server stopped sending. None of
 * those throw — they just produce a blank rectangle in front of an audience.
 *
 * So this runs the real app.js against the real corpus, with a stub DOM, and asserts what the page
 * actually says.
 *
 * Run: node public/ui.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { SimulatedSandboxes } = require('../adapters/simulated');
const { runAll } = require('../runPair');
const { CHANGED, TOTAL, PUBLIC_RECORD, INVARIANT_FAILURES } = require('../corpus');
const { judgeRun } = require('../judge');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

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

/* ── a DOM small enough to read, honest enough to catch things ────────── */

function makeEl(id) {
  const el = {
    id,
    _cls: new Set(),
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    title: '',
    children: [],
    appendChild(c) { this.children.push(c); },
    addEventListener(ev, fn) { (this._on ||= {})[ev] = fn; },
    classList: {
      add: (...c) => c.forEach((x) => el._cls.add(x)),
      remove: (...c) => c.forEach((x) => el._cls.delete(x)),
      contains: (c) => el._cls.has(c),
    },
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el._cls].join(' '),
    set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

/** Every id the page declares — asking for one that is not in index.html is a failure, not null. */
function domFromHtml() {
  const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const els = new Map(ids.map((id) => {
    const el = makeEl(id);
    // Carry the markup's own `hidden` across. Without this the stub starts everything visible, and
    // a test asking "is this hidden until we say so?" answers about the stub, not about the page.
    const tag = HTML.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    el.hidden = Boolean(tag && /\shidden(\s|>|\/)/.test(tag[0]));
    return [id, el];
  }));
  return {
    ids,
    document: {
      querySelector(sel) {
        const id = sel.replace(/^#/, '');
        if (!els.has(id)) throw new Error(`app.js asked for "${sel}", which index.html does not have`);
        return els.get(id);
      },
      createElement: () => makeEl(null),
      getElementById: (id) => els.get(id) || null,
      querySelectorAll: () => [],
      body: makeEl('body'),
    },
    get: (id) => els.get(id),
  };
}

async function renderedPage(treeExtra = {}) {
  const adapter = new SimulatedSandboxes();
  const r = await runAll({ adapter, changed: CHANGED });
  const pairs = r.results.map((p) => ({
    pkg: p.pkg, from: p.from, to: p.to, diff: p.diff, before: p.before, after: p.after,
    record: p.diff.changed ? PUBLIC_RECORD[`${p.pkg}@${p.to}`] || null : null,
    invariant: INVARIANT_FAILURES[`${p.pkg}@${p.to}`] || null,
  }));
  // judgeCache: null — the page is being rendered from a KNOWN payload, so a real cached verdict
  // off somebody's disk would make this suite's result depend on what they ran yesterday.
  const judged = await judgeRun(pairs, { judgeCache: null });
  pairs.forEach((p, i) => { p.judgement = judged.results[i]; });

  const payload = {
    tree: { total: TOTAL, moved: CHANGED.length },
    strategy: r.strategy,
    canSee: r.results[0].diff.canSee,
    twinsForked: r.twinsForked,
    quiet: r.quiet,
    costUsd: require('../pricing').sandboxCost(r.twinsForked).usd,
    modelCalls: judged.modelCalls,
    pairs,
  };

  const dom = domFromHtml();
  const routes = {
    '/api/tree': { total: TOTAL, moved: CHANGED.length, unchanged: TOTAL - CHANGED.length, ...treeExtra },
    '/api/run': payload,
  };

  const ctx = {
    document: dom.document,
    location: { search: '' }, // the capture hook is off unless a test turns it on
    URLSearchParams,
    window: { matchMedia: () => ({ matches: true }) }, // reduced motion: no sleeping in tests
    setTimeout,
    console,
    // Route on the path, ignoring the query string — the page asks for /api/run?strategy=… now,
    // and a stub that only matches exact URLs tests the stub rather than the page.
    fetch: async (url) => ({ json: async () => routes[String(url).split('?')[0]] }),
  };
  vm.runInNewContext(APP, ctx, { filename: 'app.js' });

  await new Promise((r2) => setImmediate(r2)); // let boot() settle
  await dom.get('run')._on.click();            // and then the run
  return { dom, payload };
}

/* ── the checks ───────────────────────────────────────────────────────── */

(async () => {
  console.log('interface');

  await it('every element app.js reaches for exists in the page', async () => {
    await renderedPage(); // the stub throws on an unknown id
  });

  await it('every class the page renders is actually styled', async () => {
    const used = new Set();
    for (const src of [APP, HTML]) {
      for (const m of src.matchAll(/class="([^"$]*)"/g)) {
        m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
      }
    }
    // classes app.js composes at runtime rather than writing literally
    ['is-quiet', 'is-minor', 'is-notable', 'is-alarming', 'is-live', 'is-delta', 'is-nothing',
     'is-changed', 'is-absent', 'sev-notable', 'sev-alarming']
      .forEach((c) => used.add(c));

    const unstyled = [...used].filter((c) => !CSS.includes(`.${c}`));
    assert.deepEqual(unstyled, [], `styled by nobody: ${unstyled.join(', ')}`);
  });

  await it('the strip carries one mark per twin that will be forked', async () => {
    const { dom } = await renderedPage();
    assert.equal(dom.get('strip').children.length, CHANGED.length * 2);
  });

  await it('silence dominates the wall', async () => {
    const { dom, payload } = await renderedPage();
    const html = dom.get('wall').innerHTML;
    const quiet = payload.pairs.filter((p) => !p.diff.changed).length;
    // The wording depends on the strategy: a run blind to a channel may only claim what it saw.
    const verdict = payload.canSee && Object.values(payload.canSee).some((v) => !v)
      ? `no change in what ${payload.strategy} can see`
      : 'no behavioural change';
    const said = html.split(verdict).length - 1;
    assert.equal(said, quiet, `every quiet package should say "${verdict}", once`);
    assert.ok(quiet > payload.pairs.length / 2, 'if most packages changed, the corpus is wrong');
  });

  await it('a quiet package shows no columns — there is nothing to compare', async () => {
    const { dom } = await renderedPage();
    const rows = dom.get('wall').innerHTML.split('<article').slice(1);
    rows.filter((r) => /no (behavioural change|change in what)/.test(r)).forEach((r) => {
      assert.ok(!r.includes('pair__cols'), 'a quiet package drew a diff it does not have');
    });
  });

  await it('the planted credential theft reaches the page as alarming', async () => {
    const { dom } = await renderedPage();
    const c = dom.get('catch').innerHTML;
    assert.match(c, /express-fileupload/);
    assert.match(c, /alarming/);
    assert.match(c, /env\s+\w*(TOKEN|SECRET)/i, 'the transcript should show the credential read');
    assert.match(c, /connect\s+\S+:\d+/, 'and where it sent it');
    assert.equal(dom.get('catch-section').hidden, false);
  });

  await it('the hard negative is shown, but not as an attack', async () => {
    const { dom } = await renderedPage();
    assert.match(dom.get('wall').innerHTML, /node-fetch-retry/);
    assert.ok(!dom.get('catch').innerHTML.includes('node-fetch-retry'),
      'a documented endpoint must not be presented as the catch');
  });

  await it('the silent breakage is admitted rather than hidden', async () => {
    const { dom } = await renderedPage();
    assert.equal(dom.get('blind-section').hidden, false);
    assert.match(dom.get('blind').innerHTML, /money-fmt/);
  });

  await it('the page says which strategy watched, and what it could not see', async () => {
    const { dom, payload } = await renderedPage();
    assert.match(dom.get('cansee').textContent, new RegExp(payload.strategy));
    assert.equal(dom.get('cansee').hidden, false);
  });

  await it('the headline numbers come from the run, not from the markup', async () => {
    const { dom, payload } = await renderedPage();
    assert.match(dom.get('s-twins').textContent, new RegExp(String(payload.twinsForked)));
    assert.match(dom.get('s-cost').textContent, /^\$\d/);
    assert.match(dom.get('status').textContent, new RegExp(String(payload.quiet)));
  });

  await it('the page shows what the models made of the catch, and which ones spoke', async () => {
    const { dom } = await renderedPage();
    const c = dom.get('catch').innerHTML;
    assert.match(c, /what the models made of it/);
    assert.match(c, /Nemotron-3-Nano/, 'the cheap model should be named');
    assert.match(c, /Nemotron-3-Ultra/, 'and the expensive one it escalated to');
    assert.match(c, /two models, independently/, 'the veto is the claim — it has to be on the page');
  });

  await it('a simulated verdict says so on the page, every time', async () => {
    delete process.env.NEBIUS_API_KEY;
    const { dom } = await renderedPage();
    const shown = dom.get('catch').innerHTML.split('simulated, no key set').length - 1;
    assert.ok(shown >= 1, 'a simulated judgement rendered as if it were a real one');
  });

  await it('the quiet majority costs no model calls, and the page says how many it made', async () => {
    const { dom, payload } = await renderedPage();
    const quiet = payload.pairs.filter((p) => !p.diff.changed);
    quiet.forEach((p) => assert.equal(p.judgement.spend.length, 0, `${p.pkg} paid for a model it did not need`));
    /*
     * The count is always shown; what it is CALLED depends on whether the calls happened.
     *
     * Every verdict in this fixture comes from `judge/verdicts/`, which is how the hosted demo runs
     * too — real Nemotron verdicts, produced by real calls, that were not made just now. Saying
     * "9 model calls" there is true of the verdicts and false of the visit, on the line most likely
     * to be read as a receipt.
     */
    const status = dom.get('status').textContent;
    assert.match(status, new RegExp(`${payload.modelCalls} (?:model calls|verdicts from cache)`));

    const fresh = payload.pairs
      .map((p) => p.judgement)
      .filter(Boolean)
      .some((j) => !j.cached && (j.spend || []).some((c) => c.simulated === false));
    assert.match(
      status,
      fresh ? /model calls/ : /verdicts from cache/,
      fresh ? 'a run that really called the models called it a cache hit'
            : 'a cached run claimed API calls it did not make'
    );
  });

  await it('the caveat names what would get past this particular strategy', async () => {
    const { dom, payload } = await renderedPage();
    const said = dom.get('cansee').textContent;
    assert.match(said, new RegExp(payload.strategy));
    if (payload.strategy === 'nodert') assert.match(said, /native addon/);
    else assert.doesNotMatch(said, /native addon/,
      'a kernel-level run is not defeated by a native addon; saying so would be nonsense');
  });

  await it('the live-run button is hidden until the server says it is allowed', async () => {
    const { dom } = await renderedPage(); // /api/tree stub does not set realAllowed
    assert.equal(dom.get('run-real').hidden, true, 'offered a live run the server would refuse');
    assert.match(dom.get('realnote').textContent, /fixture/);
    assert.match(dom.get('realnote').textContent, /STAKEOUT_ALLOW_LOCAL/, 'and says how to turn it on');
  });

  await it('when it is allowed, the page says what will actually happen', async () => {
    const { dom } = await renderedPage({ realAllowed: true, realJobs: [{ pkg: 'left-pad' }, { pkg: 'ms' }] });
    assert.equal(dom.get('run-real').hidden, false);
    const note = dom.get('realnote').textContent;
    assert.match(note, /left-pad, ms/, 'a live run must name the packages it is about to install');
    assert.match(note, /from npm/);
  });

  await it('package names from the corpus cannot inject markup', async () => {
    const { dom } = await renderedPage();
    const stray = dom.get('wall').innerHTML.match(/<(?!\/?(article|header|span|div|ul|li)\b)[a-z]/gi);
    assert.equal(stray, null, `unexpected tags rendered: ${stray}`);
  });

  await it('nothing a package controls reaches the page unescaped', () => {
    /*
     * The wall prints strings that came out of somebody else's npm package: its name, the hosts it
     * connected to, the paths it wrote, and — in the transcript block — a SAMPLE OF CODE the package
     * built at runtime. That last one is a string an attacker chose, rendered into a page.
     *
     * Both paths escape today: the channel renderers are wrapped in `esc(text)` by the caller, and
     * the transcript ends `.map(esc)`. This is a static assertion rather than a rendered one because
     * the escaping lives at those two call sites and nowhere else — checking them is checking the
     * property. The sibling repository had seven screens interpolating server text raw with `esc`
     * defined three lines away, so it is an easy thing to lose.
     */
    assert.ok(/out\.push\(`<li class="\$\{[^`]*\}">\$\{esc\(text\)\}<\/li>`\)/.test(APP),
      'the channel renderers are no longer escaped by their caller');
    assert.ok(/\]\.map\(esc\)\.join/.test(APP),
      'the transcript block is no longer escaped — it prints code a package built at runtime');

    // And nothing else may interpolate a package-controlled field directly into markup.
    const markup = [...APP.matchAll(/<(?:span|pre|li|p|b|code)[^>]*>\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    const risky = markup.filter((e) => /\b(pkg|host|path|sample|argv|from|to)\b/.test(e) && !e.startsWith('esc('));
    assert.deepEqual(risky, [], `interpolated without esc(): ${risky.join(' · ')}`);
  });

  console.log(`\n${passed} passed`);
})();
