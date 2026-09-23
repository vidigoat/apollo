import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { num, fleetTotals } from '../lib/api.js';

/**
 * Every repository on one machine, drawn rather than summarised.
 *
 * One segment per project, width by how many dependency-versions it has, so the band is the fleet
 * at its real proportions — a 945-dependency monorepo is not one row of a table next to a
 * six-dependency script.
 *
 * ── Absence is drawn as absence ─────────────────────────────────────────────
 *
 * The part of each segment nothing has observed is HATCHED under a ceiling hairline, never filled.
 * The first version filled it in a second colour and came out looking like an ordinary coverage
 * chart — which quietly says "we looked, and it was fine". We did not look. A fill is a quantity;
 * this is the absence of one, and the two must not share a visual language.
 *
 * ── And a repository that could not be read is neither ──────────────────────
 *
 * A scan reports refusals as rows with an `error` and no counts. Summing `deps` across every row
 * therefore produced NaN, and this section shipped to the live URL reading "NaN of NaN — 0%" with a
 * band that stopped drawing partway across. Every figure now comes from `fleetTotals`, which adds
 * up the rows that carry numbers and hands back the count of the ones that do not — stated in the
 * paragraph, because twenty-four repositories described as if they were twenty-eight is the same
 * lie the hatching exists to prevent.
 */
/** Kilobytes, for a download size a reader is being asked to accept. */
const kb = (bytes) => `${Math.round(bytes / 1024)} kB`;

/**
 * The URL this page is being read from.
 *
 * Printed into the command rather than hard-coded, so the copy a reader pastes is the one that
 * reaches the index they are looking at — including on a preview deployment, where a hard-coded
 * production URL would quietly point somewhere else.
 */
const origin = () => (typeof location === 'undefined' ? '' : location.origin);

export default function Fleet({ data, published }) {
  const canvas = useRef(null);
  const still = useReducedMotion();

  useEffect(() => {
    if (!data?.repos?.length) return;

    const el = canvas.current;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      el.width = w * dpr;
      el.height = h * dpr;
      const g = el.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const css = getComputedStyle(document.documentElement);
      const watched = css.getPropertyValue('--watched').trim();
      const blind = css.getPropertyValue('--blind').trim();
      const drift = css.getPropertyValue('--drift').trim();
      const rule = css.getPropertyValue('--rule').trim();

      /*
       * Only the repositories that were read. A refused lockfile has no `deps`, and summing it in
       * made `total` NaN — every segment after the first refusal was drawn at x = NaN, so the band
       * simply stopped partway across and looked like a design choice.
       */
      const { readable } = fleetTotals(data);
      const total = readable.reduce((n, r) => n + r.deps, 0);
      const gap = 2;
      let x = 0;

      for (const repo of readable) {
        const width = Math.max(2, (repo.deps / total) * (w - gap * readable.length));
        const knownH = repo.deps ? (repo.known / repo.deps) * h : 0;

        // Observed, and unremarkable. The overwhelming majority of the picture.
        g.fillStyle = watched;
        g.globalAlpha = 0.82;
        g.fillRect(x, h - knownH, width, knownH);
        g.globalAlpha = 1;

        // Never observed. Hatching, and a hairline where the fill would have stopped.
        const unknownH = h - knownH;
        if (unknownH > 1) {
          g.save();
          g.beginPath();
          g.rect(x, 0, width, unknownH);
          g.clip();
          g.strokeStyle = blind;
          g.globalAlpha = 0.34;
          g.lineWidth = 1;
          for (let d = -unknownH; d < width + unknownH; d += 6) {
            g.beginPath();
            g.moveTo(x + d, unknownH);
            g.lineTo(x + d + unknownH, 0);
            g.stroke();
          }
          g.restore();

          g.strokeStyle = blind;
          g.globalAlpha = 0.5;
          g.beginPath();
          g.moveTo(x, unknownH + 0.5);
          g.lineTo(x + width, unknownH + 0.5);
          g.stroke();
          g.globalAlpha = 1;
        }

        if (repo.drift?.length) {
          g.fillStyle = drift;
          g.fillRect(x, h - 3, width, 3);
        }

        g.strokeStyle = rule;
        g.globalAlpha = 0.6;
        g.beginPath();
        g.moveTo(x + width + gap / 2, 0);
        g.lineTo(x + width + gap / 2, h);
        g.stroke();
        g.globalAlpha = 1;

        x += width + gap;
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  if (!data?.scanned) return null;

  const { readable, refused, depVersions, known, distinct, pct, reuse } = fleetTotals(data);
  const observations = data.index?.versions ?? data.indexNow?.versions;

  return (
    <section className="wrap" id="fleet">
      <p className="eyebrow">the fleet</p>
      <h2>Run a package once. Answer for every repository that depends on it.</h2>
      <p className="lede">
        {data.demo ? (
          <>
            This is a scan of <b>{data.describes}</b>
            {data.describesNote ? <>, {data.describesNote}</> : null}. Public projects, because a
            scan of the machine that built this would be somebody's home directory on a public URL.
          </>
        ) : (
          <>
            This is a scan of this machine: <b>{num(readable.length)}</b> repositories, as they
            actually are.
          </>
        )}{' '}
        <b>{num(observations)}</b> observations already answer <b>{num(known)}</b> of its{' '}
        <b>{num(depVersions)}</b> dependency-versions — <b>{pct}%</b>
        {reuse && distinct && (
          <>
            , and those {num(depVersions)} are only <b>{num(distinct)}</b> distinct
            package-versions, so running one package settles the same question <b>{reuse}</b> times
          </>
        )}
        .
        {refused > 0 && (
          <>
            {' '}
            <b>{num(refused)}</b> more {refused === 1 ? 'lockfile was' : 'lockfiles were'} written
            in a form this reader will not guess at, so {refused === 1 ? 'it is' : 'they are'} not
            in the picture at all.
          </>
        )}
      </p>

      <motion.div
        className="band"
        /*
         * Same rule as the pipeline: the band arrives from slightly below, and is never invisible
         * on the way. A fade from zero left the fleet — the one picture this section exists for —
         * as an empty box whenever the reveal did not get to run.
         */
        initial={{ y: still ? 0 : 10 }}
        whileInView={{ y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: still ? 0 : 0.6 }}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${readable.length} repositories, ${pct}% of their dependency-versions already observed`}
        />
      </motion.div>

      <div className="legend" style={{ marginTop: 14 }}>
        <span><i style={{ background: 'var(--watched)' }} />observed, and unremarkable</span>
        <span>
          <i
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, var(--blind) 0 1px, transparent 1px 4px)',
              border: '1px solid color-mix(in oklab, var(--blind) 50%, transparent)',
            }}
          />
          never observed — not "observed, did nothing"
        </span>
      </div>

      {/*
        The offer, on the section that makes the claim.

        "Run a package once. Answer for every repository that depends on it." was, until this week,
        a sentence about an artefact that existed on exactly one laptop: the index was built locally
        and gitignored, so checking the claim meant installing two thousand packages first. It is
        published now, and the only honest place to say so is directly underneath the sentence.

        Every figure here comes from `/api/index`, which reads the file being offered. A number
        typed into this block would be one `npm run index:publish` away from being wrong, on the one
        claim a reader might actually act on.
      */}
      {published?.published && (
        <div className="offer">
          <p className="offer__lead">
            That index is a file. <b>{num(published.counts.packages)}</b> packages,{' '}
            <b>{num(published.counts.versions)}</b> versions, <b>{kb(published.gzipBytes)}</b> over
            the wire — point a repository of your own at it and nothing has to be installed first.
          </p>

          {/*
            The whole command, including the clone.

            The first version began at `node cli.js`, which silently assumed the reader had already
            cloned this — the one thing a person reading a web page has definitely not done. A
            command that only works if you already did something else is a command that fails the
            first time somebody tries it, which is the only time that matters.
          */}
          <pre className="offer__cmd">
            <code>
              {'git clone https://github.com/vidigoat/cassandra ~/stakeout\n'}
              {'cd ~/your-project\n'}
              {'node ~/stakeout/cli.js lock --index '}
              <span className="offer__url">{origin()}/index.json</span>
            </code>
          </pre>

          <p className="offer__after">
            Most of your tree will come back <b>unknown</b>, because most of npm has never been
            watched by anybody. That is reported as its own outcome and never as a pass — and it is
            the number that would have to fall for this to be worth adopting.
          </p>
        </div>
      )}

      <div className="coverage">
        <div>
          <h3>The hundredth repository is free</h3>
          <p>
            A package's behaviour does not depend on which project imported it, so it is observed
            once, centrally, and looked up after that. The expensive design runs a sandbox per pull
            request, which nobody installs twice.
          </p>
        </div>
        <div>
          <h3>Ordered by what it buys</h3>
          <p>
            The index is built in the order of how many projects share each package-version, so the
            first 500 observations answer far more than the last 500. The curve is in the README,
            and it was predicted from the ranking before anything was installed.
          </p>
        </div>
        <div>
          <h3>What the hatching costs</h3>
          <p>
            Every unhatched millimetre is a claim someone can check. Every hatched one is the
            project declining to make one, which is the more useful half of a security tool and the
            half that normally gets rendered as a reassuring zero.
          </p>
        </div>
      </div>
    </section>
  );
}
