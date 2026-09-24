/**
 * What changed between two versions — in behaviour, not in source.
 *
 * This is the whole argument of the project in one pure function. Your lockfile says
 * `2.4.1 → 2.4.2`. This says the new version reads an environment variable the old one never
 * touched and opens a socket to a host that appears in no changelog.
 *
 * Deliberately not a model. A diff of two transcripts is arithmetic, and arithmetic is
 * reproducible by anyone reading the repository. The model's job comes later — deciding which of
 * these differences *mean* something — and it is never allowed to invent one.
 */

const { quietness, unobserved } = require('../transcript/schema');

const keyFor = {
  net: (n) => `${n.host}:${n.port ?? ''}/${n.proto}`,
  dns: (d) => d,
  fs: (f) => `${f.op} ${f.path}`,
  env: (e) => e,
  proc: (p) => p.argv.join(' '),
  exec: (e) => `${e.how} ${e.sample}`,
};

function setDiff(before, after, key) {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)).map((k) => b.get(k)),
  };
}

/** Reading these is how credentials leave a machine. */
const SENSITIVE_ENV = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AWS_|GITHUB_|NPM_|SSH|PRIVATE)/i;

/*
 * npm's own settings are not credentials. `NPM_` above catches NPM_TOKEN, and it also caught
 * npm_config_loglevel — which every install script that wants to stay quiet reads — so watching the
 * install phase would have called ajv's funding banner "reads a credential". A setting that is
 * ABOUT authentication (npm_config__authToken, …:_auth, a password, a key) still is one.
 */
const readsCredential = (name) => {
  const n = String(name);
  if (/^npm_config_/i.test(n) && !/(auth|token|password|passwd|_key|keyfile|cert)/i.test(n)) return false;
  /*
   * Words, not letters. SENSITIVE_ENV matches substrings, and two real releases showed what that
   * costs: global-directory 5.0.0 was called alarming — "reads a credential" — for FAKEROOTKEY
   * (fakeroot's session variable) and PNPM_HOME (pnpm's install directory; it contains "NPM_").
   */
  return /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)AWS_|(^|_)GITHUB_|(^|_)GH_|(^|_)NPM_|SSH|(^|_)KEY(_|$)|API_?KEY|ACCESS_?KEY|KEYFILE|(^|_)AUTH(_|$))/i.test(n);
};

/** Spawning these from a package install is rarely innocent. */
const NOTABLE_PROC = /\b(curl|wget|sh|bash|zsh|powershell|nc|python|node\s+-e|eval)\b/i;

/**
 * Turning a string into a function.
 *
 * Decoding on its own is ordinary — half the registry decodes something. What matters is a string
 * becoming executable, so only the mechanisms that actually run code count as alarming; a base64
 * decode is recorded and left at minor unless it feeds one of these.
 */
const BUILDS_CODE = /^(Function|vm\.)/;

/**
 * Severity, decided by rules rather than by judgement.
 *
 * Kept deliberately coarse. The point is to rank what a human or a model should look at first, not
 * to pronounce on intent — "alarming" means *look at this now*, never "this is malicious".
 */
function severityOf(input) {
  // Tolerate a partial diff. A caller reasoning about one channel should not have to construct the
  // other five, and a crash here would be a crash in the only code that decides severity.
  const none = { added: [], removed: [] };
  const d = { net: none, dns: none, fs: none, env: none, proc: none, exec: none, ...input };
  const reasons = [];

  if (d.env.added.some(readsCredential)) reasons.push('reads a credential it did not read before');
  if (d.proc.added.some((p) => NOTABLE_PROC.test(p.argv.join(' ')))) reasons.push('spawns a shell or a downloader it did not spawn before');
  // Building code at runtime that the old version did not build. A library that starts doing this
  // between a patch release has changed in kind, not degree — and decode-then-execute is the shape
  // of every import-time compromise of 2026, precisely because the payload is never in the source.
  const built = d.exec.added.filter((e) => BUILDS_CODE.test(e.how));
  if (built.length) {
    reasons.push(`builds and runs code that did not exist in the source (${built.map((e) => e.how).join(', ')})`);
  }
  if (reasons.length) return { level: 'alarming', reasons };

  if (d.net.added.length) reasons.push(`talks to ${d.net.added.length} destination${d.net.added.length === 1 ? '' : 's'} it did not talk to before`);
  if (d.dns.added.length && !d.net.added.length) reasons.push('resolves a name it did not resolve before');
  if (reasons.length) return { level: 'notable', reasons };

  // A write that stopped is a change too, but it is not a new write: vite-node 6.0.0 no longer runs
  // esbuild's install, which deleted a file, and this line used to call that "writes somewhere new".
  if (d.fs.added.length) reasons.push('writes somewhere it did not write before');
  else if (d.fs.removed.length) reasons.push('stopped writing or deleting somewhere it did before');
  if (d.proc.added.length) reasons.push('spawns a process it did not spawn before');
  // Reading a non-sensitive variable is usually a feature flag — picocolors@1.1.1 picks up NO_COLOR
  // and FORCE_COLOR, which is exactly what you would want it to do. It is still a change, and a
  // change the tool cannot name is worse than no finding: the interface would show "changed" with
  // an empty explanation and no way to judge it.
  const envCount = d.env.added.length;
  if (envCount) reasons.push(`reads ${envCount} environment variable${envCount === 1 ? '' : 's'} it did not read before`);
  if (d.exec.added.length) reasons.push('decodes something it did not decode before');
  /*
   * There was a DNS line here too — `if (d.dns.added.length) reasons.push('resolves a name…')`.
   * It could never fire. Reaching `minor` at all means the `notable` block returned nothing, and
   * that block returns whenever `net.added` is non-empty OR `dns.added` is non-empty, so by the
   * time control arrives here `dns.added` is necessarily empty. The line read as a safety net and
   * was a no-op, and an exhaustive walk of every channel combination never once produced a DNS
   * reason at `minor` severity.
   *
   * Removed rather than left in place, because a rule nobody can trigger still looks like a rule
   * to the next person deciding whether this file handles a case. reachability.test.js now walks
   * that space on every run, so the next dead rule fails the build instead of reading as coverage.
   */
  if (reasons.length) return { level: 'minor', reasons };

  return { level: 'none', reasons: [] };
}

/**
 * Diff two transcripts of the same package at two versions.
 *
 * Refuses to compare transcripts made by different observation strategies: one run that could see
 * the network and one that could not will show a difference that is an artefact of how we watched,
 * not of what the package did. That is the most dangerous possible false positive here.
 */
function diff(before, after) {
  if (before.pkg !== after.pkg) {
    throw new Error(`Cannot compare different packages: ${before.pkg} and ${after.pkg}`);
  }
  if (before.strategy !== after.strategy) {
    throw new Error(
      `Cannot compare a "${before.strategy}" transcript with a "${after.strategy}" one — the difference would be in how we watched, not in what the package did.`
    );
  }

  // A side that never installed, or whose probe never reported, was not watched: its empty
  // channels would diff as "nothing changed" about something nobody saw. Not a comparison at all.
  const unseen = [before, after].map(unobserved).filter(Boolean);
  if (unseen.length) {
    const e = new Error(`Not watched: ${unseen.join('; ')}. That is not the same as clean.`);
    e.code = 'UNOBSERVED';
    throw e;
  }

  const parts = {};
  ['net', 'dns', 'fs', 'env', 'proc', 'exec'].forEach((field) => {
    parts[field] = setDiff(before[field], after[field], keyFor[field]);
  });

  const qb = quietness(before);
  const qa = quietness(after);
  const importSeverity = severityOf(parts);

  /*
   * The install phase, compared only when both sides watched it — an entry from before it was
   * watched has no install section, and "gained an install script" against a side that never looked
   * would be an artefact of how we watched. When both did, the same rules apply, the reasons say
   * "at install", and the diff takes the more severe of the two phases.
   */
  let install = null;
  let severity = importSeverity;
  if (before.install && after.install) {
    install = {};
    ['net', 'dns', 'fs', 'env', 'proc', 'exec'].forEach((field) => {
      install[field] = setDiff(before.install[field] || [], after.install[field] || [], keyFor[field]);
    });
    const s = severityOf(install);
    const ORDER = ['none', 'minor', 'notable', 'alarming'];
    severity = {
      level: ORDER[Math.max(ORDER.indexOf(importSeverity.level), ORDER.indexOf(s.level))],
      reasons: [...importSeverity.reasons, ...s.reasons.map((r) => `at install: ${r}`)],
    };
  }
  const changed = [...Object.values(parts), ...Object.values(install || {})].some((p) => p.added.length || p.removed.length);

  const importDelta =
    before.timing.importMs != null && after.timing.importMs != null ? after.timing.importMs - before.timing.importMs : null;

  return {
    pkg: before.pkg,
    from: before.version,
    to: after.version,
    strategy: before.strategy,
    // Said on every diff. A quiet result from a run that could not see the network is not evidence
    // of quiet behaviour, and the report has to carry that caveat with it.
    canSee: before.canSee,
    changed,
    ...parts,
    // Present only when both sides watched the install phase.
    ...(install ? { install } : {}),
    timing: { importDeltaMs: importDelta },
    severity: severity.level,
    reasons: severity.reasons,
    /*
     * "Both versions did nothing" — and how much that is worth.
     *
     * `bothQuiet` alone is a trap: `transcript()` deletes the channels a strategy cannot see, so a
     * package exfiltrating a credential under `fsdiff` produces six empty arrays and reads as quiet.
     * `quietTrustworthy` is the only one of these that supports the sentence "it did nothing", and
     * `blindTo` names what silence cannot speak for. They travel together so that no consumer can
     * pick up the claim without the caveat attached to the same object.
     */
    bothQuiet: qb.quiet && qa.quiet,
    quietTrustworthy: qb.trustworthy && qa.trustworthy,
    blindTo: qb.blindTo,
  };
}

/**
 * One line, for the wall of packages where almost nothing happened.
 *
 * This is the most-repeated sentence in the product — it sits next to two thirds of the corpus —
 * and "no behavioural change" is a stronger claim than the run can support unless the strategy
 * could see everything. Under `ebpf`, which cannot see code built at runtime, the honest form is
 * "no change in what ebpf can see", and the difference between those two sentences is the whole
 * reason `canSee` exists.
 *
 * The strong sentence is still printed, for the strategy that earns it. It just has to earn it.
 */
function summarise(d) {
  if (d.changed) return `${d.pkg} ${d.from} → ${d.to}: ${d.reasons.join('; ')}`;
  const qualified = d.blindTo && d.blindTo.length
    ? `no change in what ${d.strategy} can see`
    : 'no behavioural change';
  return `${d.pkg} ${d.from} → ${d.to}: ${qualified}`;
}

module.exports = { diff, summarise, severityOf, SENSITIVE_ENV, readsCredential, NOTABLE_PROC, BUILDS_CODE };
