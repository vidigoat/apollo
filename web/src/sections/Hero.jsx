import { ArrowDown, ShieldAlert } from 'lucide-react';
import { useLive, readable, channelName } from '../lib/live.js';
import { Logo, NebiusLogo } from '../lib/logos.jsx';
import { num } from '../lib/api.js';

/**
 * ── The first screen ────────────────────────────────────────────────────────
 *
 * The claim, what it runs on, and then the evidence — not a planted example but the most severe
 * release the live watch has actually caught, read from its record. Every figure here comes from
 * that record; if it cannot be fetched, the strip and the card are simply not drawn.
 */

const RANK = { alarming: 3, notable: 2, minor: 1 };

export default function Hero() {
  const live = useLive();
  const top = live?.moved?.slice().sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0) || (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0))[0];

  return (
    <section className="hero" id="top">
      <div className="hero__inner wrap">
        <p className="badge">
          <span>Runs on</span>
          <NebiusLogo height={13} title />
          <span className="badge__rule" aria-hidden="true" />
          <Logo name="nvidia" height={13} />
          <span>Nemotron</span>
        </p>

        <h1>
          Your lockfile pins versions.
          <br />
          Apollo pins behaviour.
        </h1>

        <p className="hero__lead">
          Every new release of an npm package is installed and run in a disposable Nebius sandbox,
          beside the version before it. Apollo tells you what the new code started doing — before
          you upgrade.
        </p>

        <div className="hero__actions">
          <a className="button button--solid" href="#yours">Check your lockfile</a>
          <a className="button button--line" href="#live">See what it caught<ArrowDown size={16} strokeWidth={2} /></a>
        </div>

        {live && (
          <p className="pulse">
            <span className="pulse__dot" aria-hidden="true" />
            <span>Watching npm now</span>
            <span className="pulse__sep" aria-hidden="true" />
            <span><b>{num(live.releasesWatched)}</b> releases compared</span>
            {live.medianMinutesToVerdict != null && (
              <>
                <span className="pulse__sep" aria-hidden="true" />
                <span>verdict <b>{live.medianMinutesToVerdict} min</b> after publish</span>
              </>
            )}
            <span className="pulse__sep" aria-hidden="true" />
            <span><b>{num(live.caught)}</b> changed behaviour</span>
          </p>
        )}
      </div>

      {top && (
        <div className="wrap">
          <article className="catch" aria-label="The most severe release the live watch has caught">
            <header className="catch__head">
              <span className="catch__traffic" aria-hidden="true"><i /><i /><i /></span>
              <span className="catch__title">Caught by the live watch</span>
              <span className={`sev sev--${top.severity}`}>
                <ShieldAlert size={13} strokeWidth={2.4} aria-hidden="true" />
                {top.severity}
              </span>
            </header>
            <div className="catch__body">
              <p className="catch__pkg">
                <Logo name="npm" height={12} title={false} />
                <b>{top.pkg}</b>
                <span className="catch__ver">{top.from}</span>
                <span className="catch__arrow" aria-hidden="true">→</span>
                <span className="catch__ver catch__ver--new">{top.to}</span>
                {top.weeklyDownloads ? <span className="catch__dl">{num(top.weeklyDownloads)} downloads a week</span> : null}
              </p>
              <ul className="catch__lines">
                {Object.entries(top.gained || {}).flatMap(([c, g]) =>
                  (g.added || []).slice(0, 3).map((a) => (
                    <li key={`${c}${a}`}>
                      <span className="catch__plus" aria-hidden="true">+</span>
                      <span className="catch__ch">{channelName(c)}</span>
                      <code>{readable(a)}</code>
                    </li>
                  ))
                )}
              </ul>
              {top.reasons?.[0] && <p className="catch__why">{top.reasons[0]}</p>}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
