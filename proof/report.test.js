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

it('the worked example is clearly labelled synthetic, not a real package', () => {
  const d = demoReport();
  assert.match(d, /worked example/i);
  assert.match(d, /synthetic/i);
  assert.match(d, /not a real package/i);
});

console.log(`\n${passed} passed`);
