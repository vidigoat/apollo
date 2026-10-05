import { useEffect, useState } from 'react';
import { m, useScroll, useSpring } from 'motion/react';
import Hero from './sections/Hero.jsx';
import Run from './sections/Run.jsx';
import Fleet from './sections/Fleet.jsx';
import How from './sections/How.jsx';
import Check from './sections/Check.jsx';
import Yours from './sections/Yours.jsx';
import Releases from './sections/Releases.jsx';
import Live from './sections/Live.jsx';
import Limits from './sections/Limits.jsx';
import { tree, fleet, published, run, num } from './lib/api.js';

const SECTIONS = [
  ['top', 'apollo'],
  ['live', 'npm, as it publishes'],
  ['yours', 'try it on yours'],
  ['releases', 'this week\'s releases'],
  ['run', 'the run'],
  ['check', 'on the pull request'],
  ['fleet', 'the fleet'],
  ['how', 'how it works'],
  ['limits', 'limits'],
];

export default function App() {
  const [meta, setMeta] = useState(null);
  const [calls, setCalls] = useState(null);
  const [scan, setScan] = useState(null);
  const [index, setIndex] = useState(null);
  const [here, setHere] = useState('top');

  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 28, restDelta: 0.001 });

  useEffect(() => {
    // Both are optional. If the server cannot answer, the elements that would have held those
    // numbers are simply not rendered — a page that prints a fallback figure is a page that lies
    // quietly on the day the API breaks.
    tree().then(setMeta).catch(() => {});
    // The default run's model-call count, for the one headline that states it. Served from the
    // committed verdicts, so loading the page spends nothing.
    run().then((r) => setCalls(r.modelCalls)).catch(() => {});
    fleet().then(setScan).catch(() => {});
    published().then(setIndex).catch(() => {});
  }, []);

  useEffect(() => {
    const seen = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] > 0) setHere(best[0]);
      },
      { threshold: [0, 0.15, 0.4, 0.7, 1] }
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [meta, scan]);

  return (
    <>
      {/* How far down the record you have read. One hairline, at the very top. */}
      <m.div
        style={{
          scaleX: progress,
          transformOrigin: '0 50%',
          position: 'fixed',
          insetInline: 0,
          top: 0,
          height: 1,
          background: 'var(--watched)',
          zIndex: 50,
        }}
      />

      <nav aria-label="sections">
        <ul className="spine">
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <button
                className="spine__item"
                data-on={here === id}
                onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}
              >
                <span className="spine__tick" aria-hidden="true" />
                <span className="spine__label">{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main>
        <Hero />

        {/*
          The figures sit UNDER the first screen, as its floor.
          
          They used to be a separate band further down, which left the hero composition floating in
          the middle of a tall dark rectangle with nothing beneath it — airy on a designer's screen
          and unfinished on anybody else's. A first screen needs a base: mark, then the claim and
          its evidence, then the numbers those rest on.
        */}
        {meta && (
          <div className="wrap slate-band">
            <dl className="slate">
              <div>
                <dt>dependency tree</dt>
                <dd>{num(meta.total)}</dd>
              </div>
              <div>
                <dt>versions that moved</dt>
                <dd>{num(meta.moved)}</dd>
              </div>
              <div>
                <dt>re-run</dt>
                <dd>
                  {num(meta.moved)} <small>not {num(meta.unchanged)}</small>
                </dd>
              </div>
              {scan?.index && (
                <div>
                  <dt>observations held</dt>
                  <dd>{num(scan.index.versions)}</dd>
                </div>
              )}
              <div className="wide">
                <dt>judged by</dt>
                <dd>Nemotron 3 — Nano 30B → Ultra 550B → Super 120B as veto</dd>
              </div>
              <div className="wide">
                <dt>running on</dt>
                <dd>Nebius Token Factory · open source, MIT</dd>
              </div>
            </dl>
          </div>
        )}

        {/* The real registry first: what was watched as it published, before anything a visitor does. */}
        <Live />
        <Yours />
        <Releases />
        <Run strategies={meta?.strategies || []} tree={meta} />
        <Check />
        {scan && <Fleet data={scan} published={index} />}
        <How tree={meta} calls={calls} />
        <Limits />
      </main>

      <footer className="wrap">
        <span>Apollo — a behavioural lockfile</span>
        <span>Nebius × NVIDIA · Coding &amp; Agentic Engineering</span>
        <a href="https://github.com/vidigoat/apollo">the source</a>
      </footer>
    </>
  );
}
