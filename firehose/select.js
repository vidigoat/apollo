/**
 * What, of everything npm publishes, is worth a sandbox.
 *
 * Two populations, handled very differently:
 *
 *   WATCHED   — the packages the index holds: 7,933 names taken from real lockfiles, so the ones
 *               real projects actually install. A new stable release of one of them is watched
 *               the way every pair in this project is watched: previous release and new release,
 *               two twins from one checkpoint (runPair), the differ decides.
 *
 *   LOOKALIKE — a brand-new package whose name imitates a popular one (`lodahs`, `lo-dash`,
 *               `@someone/lodash`). These are the likeliest place for real malware, which is
 *               exactly why they are NOT run here: the sandbox API offers no way to switch a
 *               run's network off, and executing a suspected payload with open egress would make
 *               Nebius's machines send whatever it sends. They are found and described from their
 *               published metadata alone. Running them waits for containment (the interrogation
 *               phase), and is a decision for then, not a side effect of now.
 *
 * Nothing in this file assigns a severity. The differ is the only place that does
 * (architecture.test.js); what this file produces is SIGNALS — facts about a publish, such as "the
 * account that published it has never published this package before", which a person or a later
 * stage weighs. A signal is never a verdict.
 */

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const cmp = (a, b) => {
  const x = STABLE.exec(a).slice(1).map(Number);
  const y = STABLE.exec(b).slice(1).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/**
 * Stable versions published after `after`, each with the stable release just below it.
 *
 * Read from the packument's `time` map, which is when npm says each version was published. A
 * version listed in `time` but missing from `versions` was unpublished, and is skipped. A
 * prerelease is counted and not watched: canary channels publish several a day, and a pair has to
 * mean "the release people will get", which a prerelease is not. A version with no stable release
 * below it (a package's first) has nothing to be compared with, and is reported as such.
 *
 * The "previous" of a backport is the release below it on its own line: 3.4.9 published after
 * 4.2.0 is compared with 3.4.8, which is what someone on 3.x is upgrading from.
 */
function newReleases(packument, { after }) {
  const time = packument?.time || {};
  const versions = packument?.versions || {};
  const since = Date.parse(after);
  const out = { releases: [], prerelease: 0, unpublished: 0, noPrior: 0 };
  const stable = Object.keys(versions).filter((v) => STABLE.test(v)).sort(cmp);
  for (const [v, at] of Object.entries(time)) {
    if (v === 'created' || v === 'modified') continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t) || !(t > since)) continue;
    if (!versions[v]) { out.unpublished++; continue; }
    if (!STABLE.test(v)) { out.prerelease++; continue; }
    const prior = stable.filter((s) => cmp(s, v) < 0).pop();
    if (!prior) { out.noPrior++; continue; }
    out.releases.push({ version: v, prior, publishedAt: new Date(t).toISOString() });
  }
  out.releases.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return out;
}

const publisher = (v) => v?._npmUser?.name || null;
const hasProvenance = (v) => Boolean(v?.dist?.attestations || v?._npmUser?.trustedPublisher);
const installScripts = (v) => Object.fromEntries(INSTALL_SCRIPTS.filter((s) => v?.scripts?.[s]).map((s) => [s, String(v.scripts[s]).slice(0, 200)]));

/**
 * What the publish itself says, before anything runs — the new release against the one before it.
 *
 * Each of these is how a real compromise has looked: a stolen token publishes from an account
 * that has never published the package (or from a person's account where CI used to publish), the
 * release loses the provenance its predecessors carried, and it gains an install script. Any one of
 * them has innocent explanations, which is why they are signals and the behaviour is the evidence.
 */
function publishSignals(packument, version, prior) {
  const vs = packument?.versions || {};
  const now = vs[version];
  const before = vs[prior];
  const signals = [];
  if (!now) return signals;
  const who = publisher(now);
  const earlier = Object.entries(packument.time || {})
    .filter(([k, t]) => vs[k] && k !== version && Date.parse(t) < Date.parse(packument.time[version]))
    .map(([k]) => publisher(vs[k]))
    .filter(Boolean);
  if (who && earlier.length && !earlier.includes(who)) signals.push({ signal: 'new-publisher', detail: `published by ${who}, who had not published this package before` });
  if (before && hasProvenance(before) && !hasProvenance(now)) signals.push({ signal: 'provenance-dropped', detail: `${prior} carried provenance; ${version} does not` });
  const was = installScripts(before);
  const is = installScripts(now);
  for (const [s, cmd] of Object.entries(is)) {
    if (was[s] !== cmd) signals.push({ signal: was[s] ? 'install-script-changed' : 'install-script-added', detail: `${s}: ${cmd}` });
  }
  const oldDeps = new Set(Object.keys(before?.dependencies || {}));
  const added = Object.keys(now.dependencies || {}).filter((d) => !oldDeps.has(d));
  if (added.length) signals.push({ signal: 'dependencies-added', detail: added.slice(0, 10).join(', ') });
  return signals;
}

/* ── lookalikes ─────────────────────────────────────────────────────────── */

/** Optimal string alignment distance: insertions, deletions, substitutions, and one adjacent swap. */
function distance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const squash = (n) => n.toLowerCase().replace(/[-_.]/g, '');

/**
 * The popular names a new package could be imitating, prepared once.
 *
 * `targets` is the most-downloaded part of the watched population — the names worth imitating.
 */
function lookalikeIndex(targets) {
  const bySquash = new Map();
  const unscoped = [];
  for (const t of targets) {
    bySquash.set(squash(t), t);
    if (!t.startsWith('@')) unscoped.push(t);
  }
  return { targets: new Set(targets), bySquash, unscoped };
}

/**
 * Is `name` a new name that imitates a popular one? `{ target, kind }` or null.
 *
 *   separator — the same letters with the punctuation moved (`lo-dash`, `core_js`)
 *   typo      — one edit away, for names of five letters or more (`lodahs`, `expres`): below
 *               five, one edit from something popular is most short names on npm
 *   scope     — a popular unscoped name put under someone's scope (`@someone/lodash`); @types/* is
 *               a convention, not an imitation, and is never flagged
 *
 * A candidate is a candidate. Plenty are innocent — a fork, a student's copy — which is why the
 * output is a description for a person, never an accusation.
 */
function lookalike(name, index) {
  if (!name || index.targets.has(name)) return null;
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  if (scoped) {
    if (scoped[1] === 'types') return null;
    if (index.targets.has(scoped[2]) && !scoped[2].startsWith('@')) return { target: scoped[2], kind: 'scope' };
    return null;
  }
  const same = index.bySquash.get(squash(name));
  if (same && same !== name) return { target: same, kind: 'separator' };
  if (name.length < 5) return null;
  for (const t of index.unscoped) {
    if (t.length < 5 || Math.abs(t.length - name.length) > 1) continue;
    if (distance(name, t, 1) === 1) return { target: t, kind: 'typo' };
  }
  return null;
}

/**
 * A lookalike described from its metadata, never run: what someone deciding whether to look
 * closer would want to know first.
 */
function describeLookalike(packument, match, targetDescription = null) {
  const latest = packument?.['dist-tags']?.latest;
  const v = packument?.versions?.[latest] || {};
  const facts = {
    name: packument?.name,
    imitates: match.target,
    kind: match.kind,
    version: latest || null,
    createdAt: packument?.time?.created || null,
    publisher: publisher(v),
    installScripts: installScripts(v),
    dependencies: Object.keys(v.dependencies || {}).slice(0, 20),
    unpackedSize: v.dist?.unpackedSize ?? null,
    fileCount: v.dist?.fileCount ?? null,
    repository: v.repository?.url || (typeof v.repository === 'string' ? v.repository : null),
    provenance: hasProvenance(v),
  };
  const signals = [];
  if (Object.keys(facts.installScripts).length) signals.push('runs a script on install');
  if (!facts.repository) signals.push('names no source repository');
  if (targetDescription && packument?.description && packument.description.trim() === String(targetDescription).trim()) signals.push(`copies ${match.target}'s description word for word`);
  return { ...facts, signals };
}

module.exports = { STABLE, cmp, newReleases, publishSignals, distance, lookalikeIndex, lookalike, describeLookalike, installScripts, hasProvenance };
