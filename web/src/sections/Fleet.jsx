import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { num } from '../lib/api.js';

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
 */
export default function Fleet({ data }) {
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

      const total = data.repos.reduce((n, r) => n + r.deps, 0);
      const gap = 2;
      let x = 0;

      for (const repo of data.repos) {
        const width = Math.max(2, (repo.deps / total) * (w - gap * data.repos.length));
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

  const deps = data.repos.reduce((n, r) => n + r.deps, 0);
  const known = data.repos.reduce((n, r) => n + r.known, 0);
  const pct = deps ? Math.round((known / deps) * 100) : 0;
  const observations = data.index?.versions ?? data.indexNow?.versions;
  const reuse = observations ? (known / observations).toFixed(1) : null;

  return (
    <section className="wrap" id="fleet">
      <p className="eyebrow">the fleet</p>
      <h2>Run a package once. Answer for every repository that depends on it.</h2>
      <p className="lede">
        {data.demo ? (
          <>
            This is a scan of <b>{data.describes}</b>, a public monorepo, because a scan of the
            machine that built this would be somebody's home directory on a public URL.
          </>
        ) : (
          <>
            This is a scan of this machine: <b>{num(data.repos.length)}</b> repositories, as they
            actually are.
          </>
        )}{' '}
        <b>{num(observations)}</b> observations answered <b>{num(known)}</b> of{' '}
        <b>{num(deps)}</b> dependency-versions — <b>{pct}%</b>
        {reuse && (
          <>
            , which is every observation doing the work of <b>{reuse}</b>
          </>
        )}
        .
      </p>

      <motion.div
        className="band"
        initial={{ opacity: still ? 1 : 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: still ? 0 : 0.6 }}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${data.repos.length} repositories, ${pct}% of their dependency-versions already observed`}
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
