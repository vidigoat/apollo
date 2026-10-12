import { useState } from 'react';
import { Radio, Timer, GitCompareArrows, ShieldAlert, Fingerprint } from 'lucide-react';
import ReleaseRow from '../components/ReleaseRow.jsx';
import { num } from '../lib/api.js';
import { useLive } from '../lib/live.js';

/**
 * ── npm, watched as it publishes ────────────────────────────────────────────
 *
 * The watcher follows npm's change feed and, for every new release of a package the index holds,
 * forks two Nebius Sandboxes from one checkpoint, installs and imports the new release and the one
 * before it, and diffs them. This is its record: the totals, every release that behaved
 * differently with the evidence one click away, and the new packages imitating popular names.
 *
 * A release caught up after downtime is said to be one — "minutes after publish" is a claim about
 * the watcher while it is running, and folding catch-up verdicts into it would flatter it.
 */

const RANK = { alarming: 3, notable: 2, minor: 1 };
const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 86400000)) : null);

export default function Live() {
  const data = useLive();
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);
  if (!data) return null;

  const days = daysSince(data.watchingSince);
  const moved = (data.moved || []).slice().sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0) || (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));
  const looks = data.lookalikes || { found: 0, recent: [] };

  return (
    <section className="wrap" id="live">
      <header className="head head--split">
        <div>
          <h2>npm, watched as it publishes</h2>
          <p className="lede">
            For every new release of a package in the index, two Nebius Sandboxes fork from one
            checkpoint: one installs the new version, one the version before it. What differs is the
            verdict, usually minutes after publish.
          </p>
        </div>
        {data.publishedAt && (
          <p className="asof">
            <span className="pulse__dot" aria-hidden="true" />
            Updated {new Date(data.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        )}
      </header>

      <dl className="stats">
        <div>
          <dt><GitCompareArrows size={15} aria-hidden="true" />Releases compared</dt>
          <dd>{num(data.releasesWatched)}</dd>
          {days != null && <span>over {num(days)} day{days === 1 ? '' : 's'}</span>}
        </div>
        <div>
          <dt><Timer size={15} aria-hidden="true" />Median time to verdict</dt>
          <dd>{data.medianMinutesToVerdict != null ? `${data.medianMinutesToVerdict} min` : '—'}</dd>
          {data.watchedLive != null && <span>across {num(data.watchedLive)} seen as they published</span>}
        </div>
        <div>
          <dt><ShieldAlert size={15} aria-hidden="true" />Behaved differently</dt>
          <dd>{num(moved.length)}</dd>
          <span>{num(moved.filter((m) => m.severity === 'alarming').length)} alarming</span>
        </div>
        <div>
          <dt><Fingerprint size={15} aria-hidden="true" />Imitating a popular name</dt>
          <dd>{num(looks.found)}</dd>
          <span>new packages, never run</span>
        </div>
      </dl>

      <div className="list" role="list">
        <div className="list__head" aria-hidden="true">
          <span>Release</span>
          <span>What changed</span>
          <span>Downloads / week</span>
          <span>Verdict</span>
        </div>
        {moved.length === 0 && (
          <p className="list__empty">
            Every release did what the version before it did, on every channel. That is what a
            healthy week on npm looks like.
          </p>
        )}
        {(all ? moved : moved.slice(0, 8)).map((r) => {
          const id = `${r.pkg}@${r.from}→${r.to}`;
          return <ReleaseRow key={id} r={r} open={open === id} onToggle={() => setOpen(open === id ? null : id)} />;
        })}
      </div>
      {moved.length > 8 && (
        <button type="button" className="button button--line list__more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show all ${num(moved.length)}`}
        </button>
      )}
      <p className="footnote">
        "Alarming" means read it before you merge, never "malicious". A changed release is a question
        for a person, and the evidence is here so they can answer it.
      </p>

      {looks.recent?.length > 0 && (
        <div className="lookalikes">
          <h3><Radio size={16} aria-hidden="true" />New packages imitating popular names</h3>
          <p className="footnote">Described from their published metadata only. A suspected package is never run with the network open.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th scope="col">New package</th><th scope="col">Looks like</th><th scope="col">How</th><th scope="col">Signals</th></tr>
              </thead>
              <tbody>
                {looks.recent.slice(0, 8).map((l) => (
                  <tr key={l.name}>
                    <td className="mono">{l.name}</td>
                    <td className="mono">{l.imitates}</td>
                    <td>{l.kind}</td>
                    <td className="wrapcell">{(l.signals || []).join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
