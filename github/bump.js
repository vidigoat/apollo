/**
 * What a pull request UPGRADES, and whether the new version behaves like the one it replaces.
 *
 * The lock check answers "a version that did not move now behaves differently". This answers the
 * question a dependency bot's pull request actually poses: the version DID move — from a release
 * somebody has been running to one published last week — so what does the new one do that the old
 * one did not? That is the pull request a person merges without reading, forty times a month.
 *
 * Two sources, in order, and neither runs anything:
 *
 *   the watch   — the live watcher ran this exact pair, old against new, from one checkpoint, as
 *                 the release was published (public/watched-releases.json). The strongest answer.
 *   the index   — both versions were observed separately; their recorded behaviours are diffed
 *                 by the same pure differ. Weaker only in that the two runs were not twins.
 *
 * A pair neither source covers is `unknown`, by name. It is never folded into "the same".
 */

const { diff } = require('../differ/diff');
const { CHANNELS } = require('../index/schema');

const ORDER = ['none', 'minor', 'notable', 'alarming'];
const own = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const short = (x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 120);

/** A diff's changes per channel as short strings — the same shape the watcher records. */
function gainedOf(d) {
  const out = {};
  for (const c of CHANNELS) {
    const a = (d[c]?.added || []).map(short);
    const r = (d[c]?.removed || []).map(short);
    if (a.length || r.length) out[c] = { added: a, removed: r };
    const ia = (d.install?.[c]?.added || []).map(short);
    const ir = (d.install?.[c]?.removed || []).map(short);
    if (ia.length || ir.length) out[`install.${c}`] = { added: ia, removed: ir };
  }
  return out;
}

const asTranscript = (e, pkg, version) => ({
  ...Object.fromEntries(CHANNELS.map((c) => [c, Array.isArray(e[c]) ? e[c] : []])),
  ...(e.install ? { install: Object.fromEntries(CHANNELS.map((c) => [c, e.install[c] || []])) } : {}),
  pkg, version, strategy: e.strategy, canSee: e.canSee, timing: {},
});

/**
 * @param {Array<{pkg, from, to}>} moved   from lockfile.whatMoved(base, head)
 * @param {{ index?: object, ledger?: object }} sources   ledger is the parsed watched-releases.json
 * @returns {{ changed: object[], same: object[], unknown: object[] }}
 */
function bumpReport(moved, { index = null, ledger = null } = {}) {
  const changed = [];
  const same = [];
  const unknown = [];
  const pairs = ledger && typeof ledger === 'object' ? ledger.pairs : null;

  for (const m of Array.isArray(moved) ? moved : []) {
    if (!m || typeof m.pkg !== 'string' || typeof m.from !== 'string' || typeof m.to !== 'string') continue;
    const base = { pkg: m.pkg, from: m.from, to: m.to };

    const seen = own(own(pairs, m.pkg), `${m.from}→${m.to}`);
    if (seen && ORDER.includes(seen.severity)) {
      const row = { ...base, severity: seen.severity, reasons: seen.reasons || [], gained: seen.gained || {}, explained: seen.explained || null, source: 'watched as a pair when it was published' };
      (seen.severity === 'none' ? same : changed).push(row);
      continue;
    }

    let a = null;
    let b = null;
    try { a = index?.lookup(m.pkg, m.from); b = index?.lookup(m.pkg, m.to); } catch { a = b = null; }
    if (a && b) {
      try {
        const d = diff(asTranscript(a, m.pkg, m.from), asTranscript(b, m.pkg, m.to));
        const row = { ...base, severity: d.severity, reasons: d.reasons || [], gained: gainedOf(d), explained: null, source: 'both versions in the index' };
        (d.severity === 'none' ? same : changed).push(row);
        continue;
      } catch { /* two observations that cannot be compared are not a comparison — unknown, below */ }
    }

    // Not this exact pair — but the new release may have been watched against its own predecessor.
    const hops = Object.entries(own(pairs, m.pkg) || {}).filter(([k]) => k.endsWith(`→${m.to}`)).map(([k, v]) => ({ against: k.split('→')[0], severity: v.severity, reasons: v.reasons || [] }));
    unknown.push({ ...base, ...(hops.length ? { nearest: hops[0] } : {}) });
  }

  const rank = (r) => ORDER.indexOf(r.severity);
  changed.sort((x, y) => rank(y) - rank(x) || x.pkg.localeCompare(y.pkg));
  return { changed, same, unknown };
}

/** One recorded observation in the fewest words that still identify it — not its JSON. */
function readable(item) {
  let x = item;
  if (typeof item === 'string' && item.startsWith('{')) { try { x = JSON.parse(item); } catch { return item; } }
  if (!x || typeof x !== 'object') return String(x);
  if (Array.isArray(x.argv)) return x.argv.filter(Boolean).join(' ');
  if (x.how) return x.sample ? `${x.how}(${JSON.stringify(String(x.sample).slice(0, 60))})` : x.how;
  if (x.host) return `${x.host}${x.port ? `:${x.port}` : ''}`;
  if (x.path) return `${x.op || ''} ${x.path}`.trim();
  return JSON.stringify(x);
}

/** Evidence as lines a reviewer reads on the pull request. */
function evidence(gained) {
  const lines = [];
  for (const [channel, g] of Object.entries(gained && typeof gained === 'object' ? gained : {})) {
    if (!g || typeof g !== 'object') continue;
    const where = channel.startsWith('install.') ? `at install, ${channel.slice(8)}` : channel;
    if (Array.isArray(g.added) && g.added.length) lines.push(`${where}: now \`${g.added.slice(0, 6).map(readable).join('`, `')}\`${g.added.length > 6 ? ` and ${g.added.length - 6} more` : ''}`);
    if (Array.isArray(g.removed) && g.removed.length) lines.push(`${where}: no longer \`${g.removed.slice(0, 4).map(readable).join('`, `')}\``);
  }
  return lines;
}

module.exports = { bumpReport, evidence, gainedOf, readable, ORDER };
