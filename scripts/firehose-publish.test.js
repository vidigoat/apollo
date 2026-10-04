/**
 * What the catch page's summary counts — and, above all, that one bad byte in the record cannot
 * blank it. The watcher appends to results.jsonl for days; a crash or a kill mid-append leaves a
 * truncated last line, and the page that reads it must still report every good line before it.
 *
 *   node scripts/firehose-publish.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarise, explain } = require('./firehose-publish');

let passed = 0;
const it = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fh-publish-'));

console.log('live-watch summary');

it('a truncated line in the middle of the record loses only that line, not the whole watch', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [
    JSON.stringify({ key: 'a@1→2', pkg: 'a', outcome: 'watched', severity: 'none', minutesPublishToVerdict: 3 }),
    '{"key":"b@1→2","trunc',                              // a crash mid-append: a half-written line
    JSON.stringify({ key: 'c@1→2', pkg: 'c', outcome: 'watched', severity: 'alarming', gained: { net: { added: ['evil:443'] } }, weeklyDownloads: 9, minutesPublishToVerdict: 1 }),
  ].join('\n') + '\n');
  const out = summarise(dir);
  assert.equal(out.releasesWatched, 2, 'the corrupt middle line dropped the two good lines around it');
  assert.equal(out.caught, 1, 'the one release that moved was lost with the corrupt line');
  assert.equal(out.medianMinutesToVerdict, 3);
});

it('a missing record is an empty watch, not a crash', () => {
  const out = summarise(tmp());
  assert.equal(out.releasesWatched, 0);
  assert.equal(out.caught, 0);
  assert.equal(out.medianMinutesToVerdict, null);
  assert.equal(out.lookalikes.found, 0);
});

it('a truncated FINAL line — the common crash — still reports every line before it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'results.jsonl'),
    JSON.stringify({ key: 'a@1→2', pkg: 'a', outcome: 'watched', severity: 'none' }) + '\n{"key":"b@1→2","half');
  assert.equal(summarise(dir).releasesWatched, 1);
});

it('"not watched" is never counted as "watched", and shows up as its own outcome', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [
    JSON.stringify({ key: 'a@1→2', pkg: 'a', outcome: 'watched', severity: 'none' }),
    JSON.stringify({ key: 'b@1→2', pkg: 'b', outcome: 'not-installed' }),
  ].join('\n') + '\n');
  const out = summarise(dir);
  assert.equal(out.releasesWatched, 1);
  assert.deepEqual(out.notWatched, { 'not-installed': 1 });
});

it('the median is over releases seen as they published; ones caught up after downtime are counted apart', () => {
  const dir = tmp();
  const at = (m) => new Date(Date.parse('2026-10-01T00:00:00Z') + m * 60000).toISOString();
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [
    { key: 'a@1→2', pkg: 'a', outcome: 'watched', severity: 'none', publishedAt: at(0), seenAt: at(1), minutesPublishToVerdict: 2 },
    { key: 'b@1→2', pkg: 'b', outcome: 'watched', severity: 'none', publishedAt: at(0), seenAt: at(2), minutesPublishToVerdict: 4 },
    { key: 'c@1→2', pkg: 'c', outcome: 'watched', severity: 'minor', publishedAt: at(0), seenAt: at(6000), minutesPublishToVerdict: 6001 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = summarise(dir);
  assert.equal(out.medianMinutesToVerdict, 4, 'a release caught up days later was folded into the live median');
  assert.equal(out.watchedLive, 2);
  assert.equal(out.caughtUp, 1);
  assert.equal(out.moved[0].live, false);
});

it('the most severe release leads, whatever its download count', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'results.jsonl'), [
    { key: 'a@1→2', pkg: 'a', outcome: 'watched', severity: 'minor', weeklyDownloads: 9000000 },
    { key: 'b@1→2', pkg: 'b', outcome: 'watched', severity: 'alarming', weeklyDownloads: null },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(summarise(dir).moved.map((m) => m.pkg), ['b', 'a']);
});

it('a move is explained only when the record settles it: a new dependency whose own files newly run at install', () => {
  const base = { to: '0.9.0', gained: { 'install.proc': { added: [JSON.stringify({ argv: ['node', '-e', 'require(process.argv[1])', '/twin/node_modules/koffi'] })] } } };
  assert.match(explain({ ...base, signals: [{ signal: 'dependencies-added', detail: 'koffi' }] }), /dependency on koffi.*koffi's own install script/);
  // The same processes with no dependency added, or a dependency that is not what ran: no sentence.
  assert.equal(explain({ ...base, signals: [] }), null);
  assert.equal(explain({ ...base, signals: [{ signal: 'dependencies-added', detail: 'left-pad' }] }), null);
  assert.equal(explain({ to: '1', signals: null, gained: null }), null);
});

console.log(`\n${passed} passed`);
