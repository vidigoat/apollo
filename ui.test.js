/**
 * The site, and the promises it makes.
 *
 *   node ui.test.js
 *
 * A website is the one part of a project that can be beautiful and dishonest at the same time, and
 * nothing in a build step will tell you which one you have. So three things are checked here, and
 * each of them is a way this page could quietly start lying:
 *
 *   the first screen is true   Every string in the hero is an assertion about a real package in the
 *                              real corpus. It is checked against `corpus.js`, so the hero cannot
 *                              drift from the finding it is describing.
 *   no number is invented      A figure that falls back to a typed-in default looks identical to
 *                              one that is measured, right up until the API breaks in front of an
 *                              audience.
 *   one colour means one thing The register only works if `--drift` appears nowhere except where a
 *                              dependency changed behaviour.
 *
 * It reads the source rather than a browser, deliberately: these are properties of what was
 * written, and a headless browser would let them regress in a file it happened not to render.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, 'web', 'src');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const sources = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(e.name)) out.push([path.relative(WEB, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(WEB);
  return out;
};

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

(async () => {
  console.log('the site');

  const css = read('styles.css');
  const hero = read('sections', 'Hero.jsx');
  const files = sources();

  /* ── the first screen is true ───────────────────────────────────────────── */

  await it('every claim in the hero is a claim about the real corpus', () => {
    /*
     * The hero says a patch release started reading three credentials and calling a host. If that
     * were a nice sentence somebody typed, this whole project would be the thing it warns about.
     */
    const corpus = fs.readFileSync(path.join(__dirname, 'corpus.js'), 'utf8');

    const claims = [
      'express-fileupload',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'cdn-assets-delivery.workers.dev',
    ];
    for (const claim of claims) {
      assert.ok(hero.includes(claim), `the hero no longer mentions ${claim}`);
      assert.ok(corpus.includes(claim), `the hero claims ${claim} and the corpus has no such thing`);
    }

    // And the versions it prints are the versions that package actually moves between.
    const pkg = corpus.slice(corpus.indexOf('express-fileupload'));
    for (const v of ['2.1.0', '2.1.1']) {
      assert.ok(hero.includes(v), `the hero no longer shows ${v}`);
      assert.ok(pkg.slice(0, 600).includes(v), `the hero shows ${v}, which is not what the corpus moves between`);
    }
  });

  await it('the hero says the corpus is planted, on the first screen', () => {
    // A detection you cannot reproduce is a magic trick. This says so before anybody scrolls.
    assert.match(hero, /planted/i, 'the first screen no longer admits the corpus is planted');
    assert.match(hero, /npm run demo/, 'it does not say how to reproduce it');
  });

  /* ── no number is invented ──────────────────────────────────────────────── */

  await it('an unknown number renders as a dash, never as zero', async () => {
    const { num, usd } = await import('./web/src/lib/api.js');
    assert.equal(num(undefined), '—');
    assert.equal(num(null), '—');
    assert.equal(usd(undefined), '—');
    assert.equal(usd(NaN), '—');
    assert.equal(num(12986), '12,986');

    /*
     * And a real cost is shown at the precision it is known to. $0.0011 printed as "$0.00" reads
     * as free, and the entire argument is that it is not free — it is cheap enough to change what
     * you can afford to do.
     */
    assert.equal(usd(0.000114), '$0.0001');
    assert.equal(usd(0), '$0');
  });

  await it('a section with no data is not rendered rather than filled in', () => {
    // `{scan && <Fleet …>}` rather than a Fleet that quietly draws a default fleet.
    const app = read('App.jsx');
    assert.match(app, /\{scan && <Fleet/, 'the fleet renders even when the server did not answer');
    assert.match(app, /\{meta && \(/, 'the figures render even when the server did not answer');
    assert.match(read('sections', 'Fleet.jsx'), /if \(!data\?\.scanned\) return null;/);
  });

  /* ── one colour means one thing ─────────────────────────────────────────── */

  await it('exactly one saturated colour exists, and it only ever means drift', () => {
    const tokens = [...css.matchAll(/^\s*(--[a-z-]+):\s*(#[0-9a-f]{3,8});/gim)].map((m) => [m[1], m[2]]);
    assert.ok(tokens.length >= 8, `only found ${tokens.length} colour tokens — the scan is broken`);

    // Chroma, roughly: how far the channels spread. A ground or a grey stays near zero.
    const spread = (hex) => {
      const n = hex.length === 4
        ? [...hex.slice(1)].map((c) => parseInt(c + c, 16))
        : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...n) - Math.min(...n);
    };

    const loud = tokens.filter(([, hex]) => spread(hex) > 110).map(([name]) => name);
    assert.deepEqual(loud, ['--drift'], `more than one colour shouts: ${loud.join(', ')}`);
  });

  await it('no component hard-codes a colour the stylesheet does not name', () => {
    /*
     * Every colour comes from a token, so the register can be changed in one place and so nothing
     * can quietly introduce a second red that means something else.
     */
    for (const [name, src] of files) {
      const hex = [...src.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
      assert.deepEqual(hex, [], `${name} hard-codes ${hex.join(', ')} instead of using a token`);
    }
  });

  /* ── the quality floor, kept by assertion rather than by intention ──────── */

  await it('everything that moves BY ITSELF asks first whether it should', () => {
    /*
     * The rule is about motion nobody asked for. A scroll progress indicator moves only because
     * the viewer scrolled — it is the answer to an action, like a panel opening, and suppressing it
     * would remove information rather than calm anything down. What has to ask permission is
     * anything that plays on its own: `animate`, and `whileInView`.
     */
    for (const [name, src] of files) {
      if (!/\banimate=|\bwhileInView=/.test(src)) continue;
      assert.ok(
        src.includes('useReducedMotion'),
        `${name} plays an animation without reading the viewer's reduced-motion preference`
      );
    }
    // And the CSS-driven panels turn off too.
    assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none/s);
  });

  await it('no fixed-column grid is wider than a phone without a fallback', () => {
    /*
     * A check that exists because the manual one could not be done.
     *
     * `.exhibit__row` was `20px | 1fr | auto` with a nowrap caption in the third column, which
     * leaves about 250px for a twenty-four-character monospace package name on a 400px screen. It
     * does not fit — and `overflow-x: hidden` on the body means the overflow is not scrolled to,
     * it is quietly cut off, which is the worst of both.
     *
     * So: any rule whose grid columns add up to more than a phone's width has to be answered by a
     * `max-width` media query somewhere in this file. It does not check that the fallback is GOOD,
     * only that somebody thought about the case — which is exactly the thing that gets forgotten.
     */
    const PHONE = 380;

    /*
     * The contents of every `max-width` block, brace-matched.
     *
     * The first version of this split the file on `@media (max-width` and kept everything after
     * the first one — which is most of the stylesheet, so every selector below that point counted
     * as "answered" and the check passed on a deliberately broken rule. A test that cannot fail is
     * worse than no test, because it is also a claim.
     */
    const narrow = (() => {
      let out = '';
      const re = /@media[^{]*\(max-width[^{]*\{/g;
      let m;
      while ((m = re.exec(css))) {
        let depth = 1;
        let i = m.index + m[0].length;
        const from = i;
        while (i < css.length && depth > 0) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') depth--;
          i++;
        }
        out += `${css.slice(from, i)}\n`;
      }
      return out;
    })();
    assert.ok(narrow.length > 200, 'found no max-width blocks at all — the scan is broken');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*grid-template-columns[^}]*)\}/g)];
    assert.ok(rules.length >= 5, `found ${rules.length} grid rules — the scan is broken`);

    for (const [, selector, body] of rules) {
      const cols = body.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? '';
      const fixed = [...cols.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      const total = fixed.reduce((a, b) => a + b, 0);
      if (total <= PHONE) continue;

      const name = selector.trim().split(/[\s,]+/).find((t) => t.startsWith('.'));
      if (!name) continue;
      assert.ok(
        narrow.includes(name),
        `${name} lays out ${total}px of fixed columns and nothing answers it at phone width`
      );
    }
  });

  await it('focus is visible and the page never scrolls sideways', () => {
    assert.match(css, /:focus-visible\s*\{[^}]*outline:/s, 'keyboard focus is invisible');
    assert.match(css, /overflow-x: hidden/, 'nothing stops a wide child scrolling the page');
    assert.match(css, /--gut: clamp\(20px/, 'the side gutter can collapse to nothing on a phone');
  });

  await it('every section the spine points at exists', () => {
    const app = read('App.jsx');
    const ids = [...app.matchAll(/\['([a-z]+)', '[^']+'\]/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, `found ${ids.length} sections in the spine`);

    const all = files.map(([, s]) => s).join('\n');
    for (const id of ids) {
      assert.ok(all.includes(`id="${id}"`), `the spine points at #${id}, which nothing renders`);
    }
  });

  await it('the site is its own package, so stakeout still has no dependencies', () => {
    /*
     * The README claims zero dependencies and no build step, and a judge will check it. React lives
     * in web/package.json; the root one has to stay empty, and this is the assertion that says so
     * when somebody reaches for a convenient `npm i` at the top level.
     */
    const root = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.deepEqual(root.dependencies ?? {}, {}, 'stakeout itself now has dependencies');
    assert.ok(fs.existsSync(path.join(__dirname, 'web', 'package.json')), 'the site has no package of its own');

    const web = JSON.parse(fs.readFileSync(path.join(__dirname, 'web', 'package.json'), 'utf8'));
    for (const lib of ['react', 'motion']) {
      assert.ok(web.dependencies[lib], `the site claims to use ${lib} and does not depend on it`);
    }
  });

  console.log(`\n${passed} passed`);
})();
