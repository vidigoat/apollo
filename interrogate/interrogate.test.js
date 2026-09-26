/**
 * The interrogation engine and its provocation ranking. runOne and the model are faked here — the
 * engine's job is the diff and the verdict, the ranking's job is a safe ordering over a closed list.
 *
 *   node interrogate/interrogate.test.js
 */
const assert = require('node:assert');
const { interrogate, fingerprint, newBehaviour, stolenDecoy } = require('./index');
const { rankProvocations, applyOrder } = require('./rank');
const { CANARY, PROVOCATIONS } = require('./provocations');

let passed = 0;
const it = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
};

const fakeRunner = (byProvocation) => async ({ provocation }) => ({ raw: byProvocation[provocation.id] || { net: [], dns: [], fs: [], env: [], proc: [], exec: [], contained: true } });

(async () => {
  console.log('interrogation');

  await it('a package that only phones out on a CI runner is caught, and the condition named', async () => {
    const r = await interrogate({ pkg: 'sneaky', version: '1.0.0', runOneImpl: fakeRunner({
      bare: { net: [], env: ['os'], contained: true },
      'ci-with-npm-token': { net: [{ host: 'evil.example', port: 443, proto: 'tls' }, { exfil: true, marker: 'canary' }], env: ['os', 'NPM_TOKEN'], contained: true },
    }) });
    const ci = r.findings.find((f) => f.provocation === 'ci-with-npm-token');
    assert.ok(ci, 'the CI provocation produced no finding');
    assert.equal(ci.newNetwork.length, 2, 'the new network attempt was not reported');
    assert.equal(ci.stoleDecoy, true, 'the decoy on the wire was not caught');
    assert.equal(r.decoyStolen, true);
    assert.equal(r.findings.length, 1, 'something was invented for a provocation it behaved under');
  });

  await it('a package that behaves the same everywhere produces no findings', async () => {
    const same = { net: [{ host: 'registry.npmjs.org', port: 443, proto: 'tls' }], env: ['os'], contained: true };
    const r = await interrogate({ pkg: 'honest', version: '2.0.0', runOneImpl: fakeRunner(Object.fromEntries(PROVOCATIONS.map((p) => [p.id, same]))) });
    assert.equal(r.findings.length, 0, 'a package doing the same thing everywhere was accused');
    assert.equal(r.decoyStolen, false);
  });

  await it('behaviour already in the bare run is not a finding — only what the provocation ADDED', async () => {
    const r = await interrogate({ pkg: 'noisy', version: '1.0.0', runOneImpl: fakeRunner({
      bare: { net: [{ host: 'a.example', port: 443, proto: 'tls' }], contained: true },
      'cloud-creds': { net: [{ host: 'a.example', port: 443, proto: 'tls' }], fs: ['read .aws/credentials'], contained: true },
    }) });
    const f = r.findings.find((x) => x.provocation === 'cloud-creds');
    assert.ok(f, 'reading a planted credential was not a finding');
    assert.ok(!(f.newNetwork || []).length, 'the pre-existing connection was counted as new');
    assert.deepEqual(f.newBehaviour.fs, ['read .aws/credentials']);
  });

  await it('the install phase counts too: a stealer in a postinstall is caught the same way', async () => {
    const r = await interrogate({ pkg: 'evil-postinstall', version: '1.0.0', runOneImpl: fakeRunner({
      bare: { net: [], install: { net: [] }, contained: true },
      'ci-with-npm-token': { net: [], install: { net: [{ exfil: true, marker: 'canary' }] }, contained: true },
    }) });
    assert.equal(r.decoyStolen, true, 'a decoy exfiltrated during install was missed');
  });

  await it('findings are ordered with the sharpest first: a stolen decoy over a mere new read', async () => {
    const r = await interrogate({ pkg: 'multi', version: '1.0.0', runOneImpl: fakeRunner({
      bare: { net: [], contained: true },
      'cloud-creds': { fs: ['read .aws/credentials'], contained: true },
      'ci-with-npm-token': { net: [{ exfil: true, marker: 'canary' }], contained: true },
    }) });
    assert.equal(r.findings[0].provocation, 'ci-with-npm-token', 'the stolen decoy was not put first');
  });

  await it('fingerprint helpers compute new behaviour and a stolen decoy as claimed', () => {
    const extra = newBehaviour(fingerprint({ net: [], env: ['os'] }), fingerprint({ net: [{ host: 'x', port: 1 }], env: ['os', 'HOME'] }));
    assert.deepEqual(extra.env, ['HOME']);
    assert.equal(extra.net.length, 1);
    assert.equal(stolenDecoy({ net: [{ exfil: true, marker: 'canary' }] }), true);
    assert.equal(stolenDecoy({ net: [`sent ${CANARY}`] }), true);
    assert.equal(stolenDecoy({ net: [{ host: 'x' }] }), false);
  });

  console.log('\nranking provocations');

  await it('the model chooses from the fixed list; an invented id is dropped, an omitted one still runs', () => {
    const ids = ['ci-with-npm-token', 'cloud-creds', 'crypto-wallet', 'clock-forward'];
    const out = applyOrder('{"order":[{"id":"crypto-wallet","why":"x"},{"id":"evil-custom","why":"y"}]}', ids);
    assert.deepEqual(out.map((o) => o.id), ['crypto-wallet', 'ci-with-npm-token', 'cloud-creds', 'clock-forward']);
    assert.ok(out.every((o) => ids.includes(o.id)), 'a made-up provocation survived');
  });

  await it('every provocation is still returned even when the model returns nothing usable', () => {
    const ids = ['ci-with-npm-token', 'cloud-creds'];
    assert.equal(applyOrder('not json', ids).length, 2);
    assert.equal(applyOrder('{"order":[]}', ids).length, 2);
  });

  await it('a model failure falls back to catalogue order, said plainly, and never throws', async () => {
    const r = await rankProvocations({ pkg: 'x', baseline: { channels: {} }, complete: async () => { throw new Error('402 budget'); } });
    assert.equal(r.simulated, true);
    assert.ok(r.order.length >= 4);
    assert.match(r.error, /402/);
  });

  await it('the ranking orders ids and never asks for code to be run', async () => {
    let asked;
    await rankProvocations({ pkg: 'lodahs', baseline: { channels: { env: 2 } }, complete: async ({ user, system }) => { asked = { user, system }; return { text: '{"order":[{"id":"ci-with-npm-token","why":"reads env"}]}', model: 'nano', simulated: false }; } });
    assert.match(asked.system, /Only use ids from the list/);
    assert.doesNotMatch(asked.system, /execute|run the code|shell/i);
  });

  console.log(`\n${passed} passed`);
})();
