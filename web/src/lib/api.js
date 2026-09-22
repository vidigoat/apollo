/**
 * The server, from the page.
 *
 * Every number this site shows comes from one of these. Nothing on the page is a figure typed into
 * a template — if the server cannot answer, the element that would have held the number is not
 * rendered at all, which is the only way a demo stays honest while you are still building it.
 */

async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

export const tree = () => get('/api/tree');
export const run = (strategy) => get(`/api/run${strategy ? `?strategy=${strategy}` : ''}`);
export const fleet = () => get('/api/fleet');

/**
 * The header of the published index, without the six hundred kilobytes under it.
 *
 * The page makes an offer — point `--index` at this URL and get these packages for free — and
 * every number in that offer has to come from the artefact being offered. Typing them in would put
 * them one `npm run index:publish` away from being wrong, on the one claim a reader might act on.
 */
export const published = () => get('/api/index');

/**
 * Thousands separators, and never a fabricated zero for something that is simply unknown.
 *
 * NaN is caught here too. It is a number by `typeof`, and it reached the live fleet paragraph as
 * the literal word "NaN" printed three times in one sentence — which is at least loud. A figure
 * that arrived broken is unknown, and unknown prints as a dash.
 */
export const num = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';

/**
 * Money, at the precision it is actually known to.
 *
 * A cost of $0.0011 rendered as "$0.00" reads as free, and the whole argument here is that it is
 * not free, it is just cheap enough to change what you can afford to do.
 */
export const usd = (n) => {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};

export const CHANNELS = ['net', 'dns', 'fs', 'env', 'proc', 'exec'];

/** One observation, in the fewest words that still identify it. */
export const describe = (x) => {
  if (x == null) return '';
  if (typeof x !== 'object') return String(x);
  if (x.host) return `${x.host}${x.port && x.port !== 443 ? `:${x.port}` : ''}`;
  // A spawned process, as a command line. The raw object printed as JSON on the page, quotes and
  // all, which is the least readable form of the most alarming thing in the transcript.
  if (Array.isArray(x.argv)) return x.argv.join(' ');
  if (x.cmd) return x.cmd;
  if (x.name) return x.name;
  if (x.path) return x.path;
  return JSON.stringify(x);
};

/**
 * The fleet, reduced to the figures the page states.
 *
 * ── Why this is a function and not four `reduce`s in the component ──────────
 *
 * A scan reports two kinds of repository: one it could read, and one it refused to. A lockfile in
 * a format this reader will not guess at comes back as `{ name, dir, error }` with no `deps` and no
 * `known` — deliberately, because reporting it as a zero-dependency project would read as "nothing
 * to check" about a project nobody checked.
 *
 * The component summed `deps` across every row, refusals included, so one `undefined` turned the
 * whole paragraph into "NaN of NaN — 0%" and the band stopped drawing at the first refused
 * repository. Four rows out of twenty-eight in the bundled scan; the page had been like that on the
 * live URL. The refusals are the honest part of the scan, and they were what broke it.
 *
 * So the arithmetic lives here, over the rows that carry numbers, and the count it could not read
 * is returned rather than dropped — the page says four were refused instead of quietly describing
 * twenty-four as if they were all of them.
 *
 * `totals` is preferred when the scan carries it: the scanner computed the same figures at scan
 * time, and two places deriving one number is how they come to disagree.
 */
export const fleetTotals = (data) => {
  const rows = data?.repos ?? [];
  const readable = rows.filter((r) => Number.isFinite(r.deps) && Number.isFinite(r.known));
  const t = data?.totals;

  const depVersions = Number.isFinite(t?.depVersions)
    ? t.depVersions
    : readable.reduce((n, r) => n + r.deps, 0);
  const known = Number.isFinite(t?.known) ? t.known : readable.reduce((n, r) => n + r.known, 0);
  const distinct = Number.isFinite(t?.distinct) ? t.distinct : null;

  return {
    readable,
    refused: rows.length - readable.length,
    depVersions,
    known,
    distinct,
    pct: depVersions ? Math.round((known / depVersions) * 100) : 0,
    /*
     * How many times running one package answers a question.
     *
     * Dependency-versions counts lodash once per project that depends on it; distinct
     * package-versions counts it once. The ratio between them is the leverage, and it is the only
     * reuse figure this payload can support. The page used to divide by every observation the index
     * held — including all the ones this fleet never asks about — which on a scan smaller than the
     * index produces a number below one, and "every observation doing the work of 0.9" is not a
     * claim anybody meant to make.
     */
    reuse: distinct ? Number((depVersions / distinct).toFixed(1)) : null,
  };
};
