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
const { summarise } = require('./firehose-publish');

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

console.log(`\n${passed} passed`);
