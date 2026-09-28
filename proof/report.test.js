/**
 * The npm-report drafter. The evidence lines are what a security team reads, so they must quote the
 * transcript exactly and claim nothing more.
 *
 *   node proof/report.test.js
 */
const assert = require('node:assert');
const { reportForRelease, evidenceLines, demoReport } = require('../scripts/firehose-report');

let passed = 0;
const it = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };

console.log('npm report');

it('evidence lines quote each channel, and mark install-time separately', () => {
  const lines = evidenceLines({ net: { added: ['evil.example:443'] }, 'install.exec': { added: [{ argv: ['sh', '-c', 'curl x'] }] }, env: { removed: ['CI'] } }).join('\n');
  assert.match(lines, /net: now evil\.example:443/);
  assert.match(lines, /exec \(at install time\): now/);
  assert.match(lines, /env: no longer CI/);
});

it('a release report carries the versions, the reproduce command, and no claim of intent', () => {
  const r = reportForRelease({ pkg: 'left-pad', from: '1.3.0', to: '1.3.1', weeklyDownloads: 5000000, severity: 'alarming', minutesPublishToVerdict: 3.2, gained: { net: { added: ['x.example:443'] } }, signals: [{ signal: 'new-publisher', detail: 'published by nobody-known' }] });
  assert.match(r, /left-pad@1\.3\.1/);
  assert.match(r, /1\.3\.0 \(previous\) vs 1\.3\.1/);
  assert.match(r, /--rewatch "left-pad@1\.3\.0→1\.3\.1"/);
  assert.match(r, /new-publisher: published by nobody-known/);
  assert.match(r, /not a judgement of intent/);
});

it('a record with a null or malformed diff still drafts, rather than crashing the report', () => {
  // The one moment this is called is when something was caught and a person needs to send it. A
  // differ that recorded no channel change leaves gained null (not undefined, so the default param
  // does not fill it), and a malformed signals entry can be null — neither may crash the drafter.
  for (const r of [
    { pkg: 'x', from: '1', to: '2', gained: null, signals: null },
    { pkg: 'x', from: '1', to: '2', gained: 'not-an-object' },
    { pkg: 'x', from: '1', to: '2', signals: [null, 'str', {}, { signal: 'a', detail: 'b' }] },
    {},
  ]) {
    const out = reportForRelease(r);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, 'drafted an empty report');
  }
  // A malformed diff produces no evidence lines, not a thrown error.
  assert.deepEqual(evidenceLines(null), []);
  assert.deepEqual(evidenceLines({ net: null, env: 42 }), []);
});

it('a huge added list is bounded in the draft — a report is an email, not a data dump', () => {
  const lines = evidenceLines({ net: { added: Array.from({ length: 5000 }, (_, i) => `h${i}`) } }).join('\n');
  assert.match(lines, /and 4980 more/, 'the evidence line should cap the list and count the rest');
});

it('the worked example is clearly labelled synthetic, not a real package', () => {
  const d = demoReport();
  assert.match(d, /worked example/i);
  assert.match(d, /synthetic/i);
  assert.match(d, /not a real package/i);
});

console.log(`\n${passed} passed`);
