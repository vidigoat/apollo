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

/** Thousands separators, and never a fabricated zero for something that is simply unknown. */
export const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

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
