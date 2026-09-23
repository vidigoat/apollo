import { useEffect, useState } from 'react';
import { num } from '../lib/api.js';

/**
 * The newest release of the most-used packages, watched against the release before it.
 *
 * Everything on this section is read from `release-watch.json`, which `scripts/release-watch.js`
 * writes after watching each pair in Nebius Sandboxes. The notes are the only hand-written part:
 * each is a change that was checked by reading both published tarballs, and says no more than that
 * reading established.
 */

const CHANNEL = { env: 'env', net: 'net', dns: 'dns', proc: 'proc', exec: 'exec', fs: 'fs' };

export default function Releases() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/release-watch.json').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;

  const all = Object.values(data.results || {});
  const same = all.filter((r) => r.severity === 'none');
  const moved = all.filter((r) => r.severity !== 'none' && r.severity !== 'failed' && r.severity !== 'unobserved')
    .sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));
  const unseen = all.length - same.length - moved.length;
  const when = data.measured ? new Date(data.measured).toISOString().slice(0, 10) : null;

  return (
    <section className="wrap" id="releases">
      <p className="eyebrow">releases</p>
      <h2>The newest release of the most-used packages, watched</h2>
      <p className="lede">
        The {num(all.length)} most-downloaded packages the index holds: each one's newest release against the
        release before it, installed and imported in two Nebius Sandboxes{when ? ` on ${when}` : ''}.{' '}
        <b>{num(same.length)} of {num(all.length)}</b> did exactly what the release before did, on every channel
        {unseen > 0 ? `; ${num(unseen)} could not be watched and are not counted as either` : ''}.
      </p>

      <div className="yours__panel">
        <h3 className="yours__h3">The {num(moved.length)} that behave differently</h3>
        {moved.map((r) => {
          const key = `${r.pkg}@${r.from}→${r.to}`;
          const note = data.notes?.[key];
          return (
            <div key={key} className="channel">
              <span className="channel__name">{r.severity}</span>
              <span>
                <b>{r.pkg}</b> {r.from} → {r.to}
                <span className="yours__quiet"> · {num(r.weeklyDownloads)} downloads a week</span>
                <br />
                {Object.entries(r.gained || {}).map(([c, g]) => (
                  <span key={c} className="channel__gained">
                    {CHANNEL[c.replace(/^install\./, '')] ? `${c.startsWith('install.') ? 'at install, ' : ''}${c.replace(/^install\./, '')}` : c}: now {g.added.slice(0, 20).join(', ')}
                    {g.added.length > 20 ? ` and ${g.added.length - 20} more` : ''}
                    <br />
                  </span>
                ))}
                {note && <span className="yours__quiet">{note}</span>}
              </span>
            </div>
          );
        })}
        <p className="yours__quiet">
          Severity comes from the differ's rules, in code; no model decides it. A change is not an accusation —
          it is what somebody would want to know before the upgrade, and a version number does not tell them.
        </p>
      </div>
    </section>
  );
}
