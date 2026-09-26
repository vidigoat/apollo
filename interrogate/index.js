/**
 * Interrogation: watch a package under decoy environments, and report what it hides.
 *
 * A package observed once, in a bare sandbox, shows its honest behaviour and — if it is a stealer
 * biding its time — nothing else. So it is observed again under each provocation
 * (interrogate/provocations.js): a CI runner with a publish token, a box with cloud keys, a crypto
 * wallet, the clock moved months on. Every run is CONTAINED, so a package that reaches for a decoy
 * and tries to send it is recorded doing so and stopped before anything leaves.
 *
 * A finding is behaviour under a provocation that the bare baseline did not show: a network attempt
 * that only appears when a token is present, a decoy credential read only on a CI runner, a clock
 * check that only fires with the date moved forward. The diff is the evidence, and the provocation
 * that produced it is the condition under which the package acts — "it exfiltrates, but only on CI".
 *
 * This runs LOCALLY and contained, never on Nebius: Nebius's AUP forbids running malicious code and
 * any egress, and suspected code is exactly what this is for. The engine takes an adapter so a test
 * can hand it a fake; in use it is the local adapter with a throwaway root.
 */

const { PROVOCATIONS, CANARY } = require('./provocations');

const CHANNELS = ['net', 'dns', 'fs', 'env', 'proc', 'exec'];

/** Everything a run reached, per channel, as comparable strings — install phase folded in. */
function fingerprint(observed) {
  const set = {};
  for (const c of CHANNELS) {
    const here = (observed?.[c] || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const inInstall = (observed?.install?.[c] || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    set[c] = new Set([...here, ...inInstall]);
  }
  return set;
}

/** What `prov` did that `base` did not — per channel, strings only in the provoked run. */
function newBehaviour(base, prov) {
  const out = {};
  for (const c of CHANNELS) {
    const extra = [...prov[c]].filter((x) => !base[c].has(x));
    if (extra.length) out[c] = extra;
  }
  return out;
}

/**
 * Did the package put a decoy on the wire? Two ways it shows: the probe's own exfil marker (it saw
 * the canary handed to a request body or socket write), or the canary value itself surfacing in any
 * recorded attempt. Either, in the import phase or the install phase, is a theft caught mid-act.
 */
function stolenDecoy(observed) {
  const nets = [...(observed?.net || []), ...(observed?.install?.net || [])];
  if (nets.some((n) => n && typeof n === 'object' && n.exfil)) return true;
  return JSON.stringify(nets).includes(CANARY);
}

/**
 * Observe one package under every provocation and diff each against the bare run.
 *
 * `runOneImpl` is runPair.js's runOne — the one place allowed to fork and required to release
 * (architecture.test.js). It is a parameter only so a test can pass a fake.
 *
 * @returns {{ pkg, version, baseline, findings, decoyStolen, provocations }}
 */
async function interrogate({ adapter, checkpoint, pkg, version, strategy, runOneImpl, provocations = PROVOCATIONS, now = () => Date.now() }) {
  const runs = {};
  for (const p of provocations) {
    const started = now();
    const t = await runOneImpl({ adapter, checkpoint, pkg, version, strategy, provocation: p.id === 'bare' ? { id: 'bare', env: {}, files: {} } : p });
    runs[p.id] = { observed: t.raw || t.observed || t, ms: now() - started, contained: (t.raw || t)?.contained };
  }
  const base = fingerprint(runs.bare?.observed);

  const findings = [];
  let decoyStolen = false;
  for (const p of provocations) {
    if (p.id === 'bare') continue;
    const observed = runs[p.id]?.observed;
    const extra = newBehaviour(base, fingerprint(observed));
    const stole = stolenDecoy(observed);
    if (stole) decoyStolen = true;
    if (Object.keys(extra).length || stole) {
      findings.push({
        provocation: p.id,
        condition: p.why,
        // A network attempt that only appears here is the sharpest of these; it leads.
        newNetwork: extra.net || [],
        newBehaviour: extra,
        stoleDecoy: stole,
      });
    }
  }
  // The network attempts first: "it only phones out under X" is the headline a person acts on.
  findings.sort((a, b) => Number(Boolean(b.stoleDecoy)) - Number(Boolean(a.stoleDecoy)) || b.newNetwork.length - a.newNetwork.length);

  return {
    pkg,
    version,
    baseline: { channels: Object.fromEntries(CHANNELS.map((c) => [c, base[c].size])), contained: runs.bare?.observed?.contained },
    findings,
    decoyStolen,
    provocations: provocations.map((p) => p.id),
  };
}

module.exports = { interrogate, fingerprint, newBehaviour, stolenDecoy, CHANNELS };
