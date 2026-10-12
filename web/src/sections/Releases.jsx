import { useEffect, useState } from 'react';
import { num } from '../lib/api.js';
import ReleaseRow from '../components/ReleaseRow.jsx';

/**
 * The newest release of the most-used packages, watched against the release before it.
 *
 * Everything on this section is read from `release-watch.json`, which `scripts/release-watch.js`
 * writes after watching each pair in Nebius Sandboxes. The notes are the only hand-written part:
 * each is a change that was checked by reading both published tarballs, and says no more than that
 * reading established.
 */


/**
 * One observed thing, as a person reads it. The record keeps processes, connections and code as
 * JSON strings; shown raw they read as {"argv":["sh","-c","node install.js"],"cmd":"sh"}.
 */

export default function Releases() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [showAll, setShowAll] = useState(false);
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
      <header className="head">
        <h2>This week's releases of the most-used packages</h2>
        <p className="lede">
          The newest release of each of the {num(all.length)} most-downloaded packages in the index,
          run against the release before it in two Nebius Sandboxes{when ? ` on ${when}` : ''}.
        </p>
      </header>

      <dl className="stats stats--3">
        <div><dt>Packages surveyed</dt><dd>{num(all.length)}</dd></div>
        <div><dt>Behaved exactly the same</dt><dd>{num(same.length)}</dd>{unseen > 0 && <span>{num(unseen)} could not be watched</span>}</div>
        <div><dt>Behaved differently</dt><dd>{num(moved.length)}</dd><span>{num(moved.filter((r) => r.severity === 'alarming').length)} alarming</span></div>
      </dl>

      <div className="list" role="list">
        <div className="list__head" aria-hidden="true">
          <span>Release</span>
          <span>What changed</span>
          <span>Downloads / week</span>
          <span>Verdict</span>
        </div>
        {(showAll ? moved : moved.slice(0, 8)).map((r) => {
          const key = `${r.pkg}@${r.from}→${r.to}`;
          return (
            <ReleaseRow
              key={key}
              r={r}
              note={data.notes?.[key]}
              judgement={r.judgement}
              open={open === key}
              onToggle={() => setOpen(open === key ? null : key)}
            />
          );
        })}
      </div>
      {moved.length > 8 && (
        <button type="button" className="button button--line list__more" aria-expanded={showAll} onClick={() => setShowAll((x) => !x)}>
          {showAll ? 'Show fewer' : `Show all ${num(moved.length)}`}
        </button>
      )}
      <p className="footnote">
        Severity comes from the differ's rules, in code; no model decides it. Open a row to see the
        evidence and what Nemotron made of it.
      </p>
    </section>
  );
}
