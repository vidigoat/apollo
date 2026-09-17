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

const { quietness } = require('../transcript/schema');

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

  if (d.env.added.some((e) => SENSITIVE_ENV.test(e))) reasons.push('reads a credential it did not read before');
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

  if (d.fs.added.length || d.fs.removed.length) reasons.push('writes somewhere it did not write before');
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

  const parts = {};
  ['net', 'dns', 'fs', 'env', 'proc', 'exec'].forEach((field) => {
    parts[field] = setDiff(before[field], after[field], keyFor[field]);
  });

  const qb = quietness(before);
  const qa = quietness(after);
  const severity = severityOf(parts);
  const changed = Object.values(parts).some((p) => p.added.length || p.removed.length);

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

/** One line, for the wall of packages where almost nothing happened. */
function summarise(d) {
  if (!d.changed) return `${d.pkg} ${d.from} → ${d.to}: no behavioural change`;
  return `${d.pkg} ${d.from} → ${d.to}: ${d.reasons.join('; ')}`;
}

module.exports = { diff, summarise, severityOf, SENSITIVE_ENV, NOTABLE_PROC, BUILDS_CODE };
