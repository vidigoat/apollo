import { useEffect, useState } from 'react';

/**
 * The live watch's own record — the bundled copy first, then the fresher one from the gist the
 * watcher syncs every ten minutes, whichever was published later.
 *
 * Every figure the hero and the live section state comes from here. Nothing about the watch is
 * typed into the page: a number that only looks measured is the one this project exists to refuse.
 */
export function useLive() {
  const [data, setData] = useState(null);
  useEffect(() => {
    const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let alive = true;
    get('/live-watch.json').then((bundled) => { if (alive && bundled) setData((d) => d || bundled); });
    get('/live-source.json')
      .then((src) => (src?.liveWatch ? get(src.liveWatch) : null))
      .then((remote) => {
        if (!alive || !remote || typeof remote.releasesWatched !== 'number') return;
        setData((d) => (!d || Date.parse(remote.publishedAt) > Date.parse(d.publishedAt) ? remote : d));
      });
    return () => { alive = false; };
  }, []);
  return data;
}

/**
 * One observation from the record, as a person would write it down.
 *
 * Long observations are stored truncated, which leaves a JSON string with no closing brace. Those
 * are read field by field rather than shown raw — a reader should never see `{"how":…` on the page.
 */
export const readable = (item) => {
  let x = item;
  if (typeof item === 'string' && item.startsWith('{')) {
    try {
      x = JSON.parse(item);
    } catch {
      const how = /"how":"([^"]+)"/.exec(item);
      const sample = /"sample":"(.*)$/.exec(item);
      const argv = /"argv":\[(.*)$/.exec(item);
      if (how) return sample ? `${how[1]}: ${sample[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 80)}…` : how[1];
      if (argv) return `${argv[1].replace(/","/g, ' ').replace(/^"|"$/g, '').replace(/\\"/g, '"').slice(0, 100)}…`;
      return item;
    }
  }
  if (typeof x === 'string') return x;
  if (Array.isArray(x.argv)) return x.argv.filter(Boolean).join(' ');
  if (x.host) return `${x.host}${x.port ? `:${x.port}` : ''}`;
  if (x.how) return x.sample && x.sample !== '· chars' ? `${x.how}: ${String(x.sample).slice(0, 80)}` : x.how;
  if (x.path) return `${x.op || ''} ${x.path}`.trim();
  return JSON.stringify(x);
};

/** Channel names as words. */
export const CHANNEL = {
  net: 'Network', dns: 'DNS', fs: 'Files', env: 'Environment', proc: 'Processes', exec: 'Runs code',
};
export const channelName = (c) => `${c.startsWith('install.') ? 'At install · ' : ''}${CHANNEL[c.replace(/^install\./, '')] || c}`;
