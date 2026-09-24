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

/**
 * One observed thing, as a person reads it. The record keeps processes, connections and code as
 * JSON strings; shown raw they read as {"argv":["sh","-c","node install.js"],"cmd":"sh"}.
 */
function readable(item) {
  let x = item;
  if (typeof item === 'string' && item.startsWith('{')) {
    try { x = JSON.parse(item); } catch {
      // The record cuts each item at 120 characters, which can cut the JSON too: read what is there.
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
}

export default function Releases() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/release-watch.json').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;

  // The site's copy is slim (scripts/release-watch.js slim()): the counts, and only the pairs that
  // did not stay the same. An older full copy still reads right.
  const listed = Object.values(data.results || {});
  const total = Number.isFinite(data.total) ? data.total : listed.length;
  const sameCount = Number.isFinite(data.tally?.none) ? data.tally.none : listed.filter((r) => r.severity === 'none').length;
  // The most severe first, then the most used: an alarming release is the row somebody came for,
  // and ordering by downloads alone put both of them near the bottom of twenty-nine.
  const RANK = { alarming: 0, notable: 1, minor: 2 };
  const moved = listed.filter((r) => r.severity in RANK)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));
  const unseen = total - sameCount - moved.length;
  const all = { length: total };
  const same = { length: sameCount };
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
                    {CHANNEL[c.replace(/^install\./, '')] ? `${c.startsWith('install.') ? 'at install, ' : ''}${c.replace(/^install\./, '')}` : c}: {g.added.length ? `now ${g.added.slice(0, 20).map(readable).join(', ')}` : ''}
                    {g.added.length > 20 ? ` and ${g.added.length - 20} more` : ''}
                    {g.removed?.length ? `${g.added.length ? ' · ' : ''}no longer ${g.removed.slice(0, 8).map(readable).join(', ')}` : ''}
                    <br />
                  </span>
                ))}
                {note && <span className="yours__quiet">{note}<br /></span>}
                {r.judgement?.meaning && (
                  <span className="yours__quiet">
                    <b>Nemotron{r.judgement.tier ? ` (${r.judgement.tier})` : ''}:</b> {r.judgement.meaning}
                    {r.judgement.record?.verdict ? ` · public record: ${r.judgement.record.verdict}` : ''}
                    {' '}· severity stays {r.judgement.severityStill || r.severity}, by the rules
                  </span>
                )}
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
