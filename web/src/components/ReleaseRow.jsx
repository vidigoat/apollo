import { ChevronDown, Sparkles } from 'lucide-react';
import { num } from '../lib/api.js';
import { readable, channelName } from '../lib/live.js';

/**
 * One release that behaved differently from the one before it: the summary on one line, the
 * evidence one click away. Shared by the live watch and the weekly survey, so the two read the same.
 */

/** "(Function, Function, Function, eval)" → "(Function, eval)" — a list said once per thing in it. */
export function tidy(text = '') {
  return String(text).replace(/\(([^()]*)\)/g, (_, inner) => {
    const items = [...new Set(inner.split(/,\s*/).map((x) => x.trim()).filter(Boolean))];
    return `(${items.length > 4 ? `${items.slice(0, 4).join(', ')} and ${items.length - 4} more` : items.join(', ')})`;
  });
}

export default function ReleaseRow({ r, open, onToggle, note, judgement }) {
  return (
    <div className="row" role="listitem" data-open={open}>
      <button type="button" className="row__main" aria-expanded={open} onClick={onToggle}>
        <span className="row__pkg">
          <b>{r.pkg}</b>
          <span>{r.from} → {r.to}</span>
        </span>
        <span className="row__what">{tidy(r.reasons?.[0] || 'behaviour changed')}</span>
        <span className="row__dl">{r.weeklyDownloads ? num(r.weeklyDownloads) : '—'}</span>
        <span className="row__sev">
          <span className={`sev sev--${r.severity}`}>{r.severity}</span>
          <ChevronDown size={16} className="row__chev" aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="row__detail">
          {Object.entries(r.gained || {}).map(([c, g]) => {
            const added = [...new Set((g.added || []).map(readable))];
            const removed = [...new Set((g.removed || []).map(readable))];
            return (
              <div className="evidence" key={c}>
                <span className="evidence__ch">{channelName(c)}</span>
                <ul>
                  {added.slice(0, 8).map((a) => <li key={`+${a}`}><span className="plus">+</span><code>{a}</code></li>)}
                  {added.length > 8 && <li className="more"><span /><span>and {added.length - 8} more</span></li>}
                  {removed.slice(0, 4).map((a) => <li key={`-${a}`}><span className="minus">−</span><code>{a}</code></li>)}
                </ul>
              </div>
            );
          })}
          {judgement?.meaning && (
            <div className="judge">
              <p className="judge__who"><Sparkles size={14} aria-hidden="true" />Nemotron{judgement.tier ? ` ${judgement.tier}` : ''} read this diff</p>
              <p>{judgement.meaning}</p>
              <p className="judge__foot">
                {judgement.record?.verdict ? `Public record: ${judgement.record.verdict}. ` : ''}
                Severity stays {judgement.severityStill || r.severity}: it comes from the rules, never the model.
              </p>
            </div>
          )}
          {(note || r.explained || r.minutesToVerdict != null) && (
            <p className="row__note">
              {r.explained ? <><b>What that is:</b> {r.explained} </> : null}
              {note ? `${note} ` : ''}
              {r.minutesToVerdict != null && (r.live === false
                ? `Watched on catching up, ${Math.round(r.minutesToVerdict / 1440)} days after publish.`
                : `Verdict ${r.minutesToVerdict} minutes after publish.`)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
