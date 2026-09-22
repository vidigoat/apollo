/**
 * A published index, and the ways one could quietly lie.
 *
 *   node index/published.test.js
 *
 * ── What is being protected ─────────────────────────────────────────────────
 *
 * `public/index.json` is the artefact that makes this project's central claim checkable: run a
 * package once, and anybody can look the answer up. The moment somebody else's repository is being
 * answered from a file we wrote, the failure modes change shape. A local index that is wrong wastes
 * an afternoon. A published one that is wrong tells a stranger their dependencies are fine.
 *
 * So, in order of how badly each would end:
 *
 *   a fabricated entry          a simulated observation reaching a real answer about real code
 *   a stale visibility table    an index claiming the filesystem was watched when writes were
 *   unknown read as clean       the normal state of somebody else's tree, and the one that must
 *                               never be silently a pass
 *   a wrong schema              read anyway, on the assumption the difference does not matter
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PublishedIndex, open } = require('./published');
const { Index, SCHEMA } = require('./schema');
const { CAN_SEE } = require('../transcript/schema');
const { buildLock, checkLock } = require('../lock');

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

const doc = (over = {}) => ({
  schema: SCHEMA,
  revision: '2026-09-21',
  generatedAt: '2026-09-21T00:00:00.000Z',
  strategies: ['nodert'],
  canSee: { nodert: { ...CAN_SEE.nodert } },
  counts: { packages: 1, versions: 1 },
  packages: {
    'left-pad': {
      '1.3.0': {
        version: '1.3.0',
        strategy: 'nodert',
        canSee: { ...CAN_SEE.nodert },
        observedAt: '2026-09-21T00:00:00.000Z',
        net: [], dns: [], fs: [], env: [], proc: [], exec: [],
      },
    },
  },
  ...over,
});

(async () => {
  console.log('a published index');

  await it('answers the same questions a local one does', () => {
    const index = new PublishedIndex(doc());
    const entry = index.lookup('left-pad', '1.3.0');
    assert.equal(entry.strategy, 'nodert');
    assert.equal(index.manifest().versions, 1);
    assert.match(index.summary(), /1 observations of 1 packages/);
    assert.equal(index.versions('left-pad').length, 1);
  });

  await it('a package it has never seen is null, not silence', () => {
    /*
     * The one that decides whether this is safe to point at somebody else's repository. Most of
     * their tree will not be in here — most of npm has not been watched by anybody — and a miss
     * that reads as "observed, did nothing" is a tool telling a stranger their dependencies are
     * fine on the basis of never having looked.
     */
    const index = new PublishedIndex(doc());
    assert.equal(index.lookup('left-pad', '9.9.9'), null);
    assert.equal(index.lookup('nothing-of-the-sort', '1.0.0'), null);
    assert.equal(index.misses, 2);
  });

  await it('unknown packages come out of a real check as unknown, never as clean', () => {
    const index = new PublishedIndex(doc());
    const tree = new Map([['left-pad', '1.3.0'], ['ghost', '9.9.9']]);
    const { lock } = buildLock(tree, index);
    const result = checkLock(lock, tree, index);
    assert.equal(result.drift.length, 0);
    assert.deepEqual(result.unknown, ['ghost@9.9.9']);
  });

  await it('what a strategy can see comes from THIS build, not from the file', () => {
    /*
     * The published document carries the table it was written with. A reader whose code disagrees
     * has to resolve that, and it resolves toward the local table — because `quietness()` here is
     * what will interpret the entry, and reading somebody else's recording with local code that
     * means something different by the same field is exactly how an overclaim travels between
     * machines.
     */
    const stale = doc();
    stale.packages['left-pad']['1.3.0'].canSee = { fs: true, net: true, dns: true, env: true, proc: true, exec: true };
    const entry = new PublishedIndex(stale).lookup('left-pad', '1.3.0');
    assert.equal(entry.canSee.fs, CAN_SEE.nodert.fs);
    assert.notEqual(entry.canSee.fs, true, 'a published entry talked this build into believing the filesystem was watched');
  });

  await it('and a disagreement about the table is reported rather than hidden', () => {
    const index = new PublishedIndex(doc({ canSee: { nodert: { ...CAN_SEE.nodert, fs: true } } }));
    const differs = index.mismatch();
    assert.equal(differs.length, 1);
    assert.match(differs[0], /nodert\.fs/);
    assert.equal(new PublishedIndex(doc()).mismatch().length, 0, 'an index that agrees reported a disagreement');
  });

  await it('a lookup cannot walk off the end of the package map', () => {
    /*
     * `doc.packages[name]?.[version]` reaches Object.prototype for a name like `constructor`:
     * `lookup('constructor', 'name')` came back as the string "Object", which is not an entry and
     * is not null either, while every caller here is written against "an entry, or null".
     *
     * Nothing on npm is called `constructor`. This index is a file fetched from a URL somebody
     * typed, and a reader that can be handed a string where a transcript belongs is one bad file
     * away from a confident wrong answer about somebody's dependencies.
     */
    const index = new PublishedIndex(doc());
    for (const name of ['constructor', 'hasOwnProperty', 'toString', '__proto__', 'valueOf']) {
      for (const version of ['name', 'prototype', 'call', '1.0.0']) {
        const entry = index.lookup(name, version);
        assert.ok(
          entry === null || (typeof entry === 'object' && typeof entry.strategy === 'string'),
          `lookup(${name}, ${version}) returned ${JSON.stringify(entry)}, which is neither an entry nor null`
        );
      }
      assert.deepEqual(index.versions(name), []);
    }

    // And reading one does not pollute anything.
    const hostile = doc();
    hostile.packages.__proto__ = { '1.0.0': { polluted: true } };
    new PublishedIndex(hostile).lookup('left-pad', '1.3.0');
    assert.notEqual({}.polluted, true);
  });

  await it('a schema it cannot read is refused, not guessed at', () => {
    assert.throws(() => new PublishedIndex(doc({ schema: SCHEMA + 1 })), /schema/);
    assert.throws(() => new PublishedIndex({ schema: SCHEMA }), /no packages/);
    assert.throws(() => new PublishedIndex(null), /not an index/);
  });

  await it('a URL that returns an error page says so, rather than "invalid JSON"', async () => {
    /*
     * The likeliest failure of all: a host that serves an HTML error page with a 200. "Not valid
     * JSON" sends somebody to look at the index. Saying what actually arrived sends them to look at
     * the URL, which is where the problem is.
     */
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<!doctype html><title>404</title>' });
    await assert.rejects(() => open('https://example.invalid/index.json', { fetchImpl }), /did not return an index/);

    const notFound = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(() => open('https://example.invalid/index.json', { fetchImpl: notFound }), /answered 404/);
  });

  await it('an index too large to read is refused before it is read', async () => {
    /*
     * The one this repository publishes is 0.58 MB. The limit is not a security boundary — the user
     * chose the URL — it is the difference between an error message and a laptop swapping, and it
     * is the same class of bug as the decompression bomb the sibling project shipped tonight: a
     * reader that will allocate whatever it is handed.
     *
     * Checked twice, because a server may decline to say how big it is, or lie.
     */
    const declared = {
      ok: true, status: 200,
      headers: { get: () => String(500 * 1024 * 1024) },
      text: async () => '{}',
    };
    await assert.rejects(
      () => open('https://example.invalid/index.json', { fetchImpl: async () => declared }),
      /500 MB and this reads at most/
    );

    const silent = {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(doc()).padEnd(4096, ' '),
    };
    await assert.rejects(
      () => open('https://example.invalid/index.json', { maxBytes: 1024, fetchImpl: async () => silent }),
      /and this reads at most/
    );

    // And a normal one still opens.
    const fine = { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(doc()) };
    const index = await open('https://example.invalid/index.json', { fetchImpl: async () => fine });
    assert.equal(index.manifest().versions, 1);
  });

  await it('it reads from a URL and from a file, and they agree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'published-'));
    const file = path.join(dir, 'index.json');
    fs.writeFileSync(file, JSON.stringify(doc()));

    const fromFile = await open(file);
    const fromUrl = await open('https://example.invalid/index.json', {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc()) }),
    });
    assert.deepEqual(fromFile.manifest().counts, fromUrl.manifest().counts);
    assert.deepEqual(fromFile.lookup('left-pad', '1.3.0'), fromUrl.lookup('left-pad', '1.3.0'));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await it('it cannot be written to, because it is somebody else\'s recording', () => {
    const index = new PublishedIndex(doc());
    assert.equal(typeof index.put, 'undefined',
      'a published index has a put() — somebody will call it and believe they recorded a run');
  });

  /* ── the file this repository actually publishes ──────────────────────────── */

  await it('what `npm run index:publish` writes is readable, and says what watched it', async () => {
    const at = path.join(__dirname, '..', 'public', 'index.json');
    if (!fs.existsSync(at)) return; // not built in this checkout; the rest of the file still holds

    const index = await open(at);
    const m = index.manifest();
    assert.ok(m.versions > 0, 'the published index is empty');
    assert.deepEqual(index.mismatch(), [], 'the published index disagrees with this build about what was watched');

    // Every strategy it claims is one this build defines, so nothing in it is uninterpretable.
    for (const s of m.strategies) assert.ok(CAN_SEE[s], `it was published with a strategy this build does not define: ${s}`);
  });

  await it('and it contains no simulated observation', () => {
    /*
     * This happened once to the local index: 8,623 fabricated entries over 705 real ones. The local
     * index refuses to mix them now, and that rule guards a directory. This file is the one a
     * stranger runs `check` against, and a fabricated entry in it is a fabricated answer about
     * their code.
     */
    const at = path.join(__dirname, '..', 'public', 'index.json');
    if (!fs.existsSync(at)) return;
    const raw = JSON.parse(fs.readFileSync(at, 'utf8'));
    for (const [name, versions] of Object.entries(raw.packages)) {
      for (const [v, e] of Object.entries(versions)) {
        assert.ok(!e.simulated, `${name}@${v} is a simulated observation, on a public URL`);
        assert.notEqual(e.strategy, 'simulated', `${name}@${v} was watched by nothing`);
      }
    }
  });

  await it('the publisher refuses a simulated entry rather than shipping it', () => {
    /*
     * Proved by handing it one. The index under test is a temporary directory, so this never
     * touches the real one.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
    const index = new Index({ dir });
    index.put('honest', {
      pkg: 'honest', version: '1.0.0', strategy: 'nodert', canSee: { ...CAN_SEE.nodert },
      net: [], dns: [], fs: [], env: [], proc: [], exec: [],
    });
    index.put('fabricated', {
      pkg: 'fabricated', version: '1.0.0', strategy: 'nodert', simulated: true,
      canSee: { ...CAN_SEE.nodert }, net: [], dns: [], fs: [], env: [], proc: [], exec: [],
    });
    index.writeManifest({ revision: 'test' });

    /*
     * `--out` into the temporary directory, which is not a nicety. Without it this wrote over the
     * repository's real, committed `public/index.json` with a one-package test artefact, every time
     * the suite ran, silently.
     */
    const at = path.join(dir, 'published.json');
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'publish-index.js'), '--out', at],
      { encoding: 'utf8', env: { ...process.env, STAKEOUT_INDEX: dir }, cwd: path.join(__dirname, '..') }
    );
    assert.match(out, /THE INDEX, AS ONE FILE/);

    const written = JSON.parse(fs.readFileSync(at, 'utf8'));
    assert.equal(written.counts.versions, 1, 'the honest entry did not survive');
    assert.ok(!written.packages.fabricated, 'a simulated observation was published');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed`);
})();
