import { useEffect, useState } from 'react';
import { num } from '../lib/api.js';

/**
 * The live watch: npm as it publishes, not a fixed list on a fixed day.
 *
 * Everything here is read from `live-watch.json`, which `scripts/firehose-publish.js` writes from the
 * running watcher's own record. It reports the honest state, whatever it is — on a quiet week that is
 * "watched N, caught 0", and it says exactly that. The number that matters is the time from a release
 * being published to a verdict existing, because that is the window in which a bad release is loose.
 */

const readable = (item) => {
  let x = item;
  if (typeof item === 'string' && item.startsWith('{')) { try { x = JSON.parse(item); } catch { return item; } }
  if (typeof x === 'string') return x;
  if (Array.isArray(x.argv)) return x.argv.filter(Boolean).join(' ');
  if (x.host) return `${x.host}${x.port ? `:${x.port}` : ''}`;
  if (x.how) return x.how;
  if (x.path) return `${x.op || ''} ${x.path}`.trim();
  return JSON.stringify(x);
};

const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 86400000)) : null);

export default function Live() {
  const [data, setData] = useState(null);
  useEffect(() => {
    /*
     * Two copies, and the newer one wins. The one bundled with the site is as old as the last
     * deploy; the watcher's machine also publishes the same summary where it can update it on its
     * own (live-source.json says where). Whichever was written later is shown, with the time it
     * was written — so a watcher that has stopped shows as an old timestamp, never as a fresh page.
     */
    const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let alive = true;
    get('/live-watch.json').then((bundled) => { if (alive && bundled) setData((d) => d || bundled); });
    get('/live-source.json').then((src) => (src?.liveWatch ? get(src.liveWatch) : null)).then((remote) => {
      if (!alive || !remote || typeof remote.releasesWatched !== 'number') return;
      setData((d) => (!d || Date.parse(remote.publishedAt) > Date.parse(d.publishedAt) ? remote : d));
    });
    return () => { alive = false; };
  }, []);
  if (!data) return null;

  const days = daysSince(data.watchingSince);
  const moved = data.moved || [];
  const looks = data.lookalikes || { found: 0, recent: [] };

  return (
    <section className="wrap" id="live">
      <p className="eyebrow">live</p>
      <h2>npm, watched as it publishes</h2>
      <p className="lede">
        The watcher follows npm's change feed and runs each new release of a package the index holds in a
        Nebius Sandbox, against the release before it — minutes after it is published.{' '}
        <b>{num(data.releasesWatched)}</b> releases watched{days != null ? ` over ${days === 0 ? 'today' : `${num(days)} day${days === 1 ? '' : 's'}`}` : ''},
        {data.medianMinutesToVerdict != null
          ? <> {data.watchedLive != null ? <><b>{num(data.watchedLive)}</b> of them seen as they were published, with</> : null} a verdict a median of <b>{data.medianMinutesToVerdict} minutes</b> after publish.</>
          : ' each with a verdict soon after it was published.'}
        {data.publishedAt ? <> <span className="yours__quiet">As of {new Date(data.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</span></> : null}
        {data.caughtUp ? <> The other {num(data.caughtUp)} were published while the watcher was down, and watched when it came back — nothing in the gap was skipped.</> : null}
      </p>

      <div className="yours__panel">
        {moved.length === 0 ? (
          <>
            <h3 className="yours__h3">Nothing has behaved differently — and that is the usual answer</h3>
            <p className="yours__quiet">
              Every one of the {num(data.releasesWatched)} releases did what the version before it did, on every
              channel. That is what a healthy week on npm looks like, and a watch that only reports when something
              is wrong cannot tell you it looked. When a release does move, it appears here with the evidence — the
              new connection, the new file, the install script — the same way the fixed survey below shows them.
            </p>
          </>
        ) : (
          <>
            <h3 className="yours__h3">The {num(moved.length)} that behaved differently</h3>
            {moved.map((r) => (
              <div key={`${r.pkg}@${r.from}→${r.to}`} className="channel">
                <span className="channel__name">{r.severity}</span>
                <span>
                  <b>{r.pkg}</b> {r.from} → {r.to}
                  {r.weeklyDownloads ? <span className="yours__quiet"> · {num(r.weeklyDownloads)} downloads a week</span> : null}
                  {r.minutesToVerdict != null
                    ? <span className="yours__quiet"> · {r.live === false ? `watched on catching up, ${Math.round(r.minutesToVerdict / 1440)} days after publish` : `caught ${r.minutesToVerdict} min after publish`}</span>
                    : null}
                  <br />
                  {Object.entries(r.gained || {}).map(([c, g]) => (
                    <span key={c} className="channel__gained">
                      {c.startsWith('install.') ? 'at install, ' : ''}{c.replace(/^install\./, '')}: {g.added?.length ? `now ${g.added.slice(0, 12).map(readable).join(', ')}` : ''}
                      {g.removed?.length ? `${g.added?.length ? ' · ' : ''}no longer ${g.removed.slice(0, 6).map(readable).join(', ')}` : ''}
                      <br />
                    </span>
                  ))}
                  {r.signals?.length ? <span className="yours__quiet">publish signals: {r.signals.join(', ')}</span> : null}
                  {r.explained ? <><br /><span className="yours__quiet">what that is: {r.explained}</span></> : null}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="yours__panel">
        <h3 className="yours__h3">
          {looks.found === 0 ? 'No new package is imitating a popular name right now' : `${num(looks.found)} new package${looks.found === 1 ? '' : 's'} imitating a popular name`}
        </h3>
        {looks.recent && looks.recent.length > 0 ? (
          looks.recent.map((l) => (
            <div key={l.name} className="channel">
              <span className="channel__name">{l.kind}</span>
              <span>
                <b>{l.name}</b> looks like <b>{l.imitates}</b>
                {l.signals?.length ? <span className="yours__quiet"> · {l.signals.join('; ')}</span> : null}
              </span>
            </div>
          ))
        ) : (
          <p className="yours__quiet">
            Brand-new packages whose names imitate popular ones are found on the feed and described from their
            published metadata — never run. Executing a suspected package with the network open is the one thing
            this will not do; drawing it out safely is what the interrogation does, contained, instead.
          </p>
        )}
      </div>
    </section>
  );
}
