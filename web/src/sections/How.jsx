import { motion, useReducedMotion } from 'motion/react';
import { num } from '../lib/api.js';

/**
 * The pipeline, as the thing it actually is: a sequence of decisions, each of which is allowed to
 * stop the next one from happening.
 *
 * The economics are the design. Running the 550B on all 1,214 packages is the obvious build and
 * the one that makes a tool like this unaffordable; every row below exists to keep a bigger model
 * from being woken up. So each row carries what it costs, because that is the argument.
 *
 * A model can explain a finding. It can never escalate one — severity comes from rules, in code,
 * that anybody can read and re-run.
 */

const STEPS = [
  {
    who: 'checkpoint',
    what: 'Boot a machine, get it healthy, snapshot it. Everything after this starts from the identical state.',
    cost: 'once',
  },
  {
    who: 'fork ×2',
    what: 'Two twins per package, at the same instant. Install the old version in one and the new in the other, then import both — where 2026\'s attacks actually fire.',
    cost: null,   // filled from the tree — see below
  },
  {
    who: 'transcript',
    what: 'net · dns · files · env · processes · code built at runtime. Temp directories, pids and hashes normalised away, so two identical runs of the same version compare equal.',
    cost: 'free',
  },
  {
    who: 'behavioural diff',
    what: 'Pure arithmetic. No model involved, reproducible by anyone. Severity comes from rules — alarming, notable, minor, none.',
    cost: 'free',
  },
  {
    who: 'Nemotron Nano 30B',
    model: true,
    what: 'Triage. Is this worth a bigger model\'s time? Runs on the handful that moved, never on the twelve hundred that did not.',
    cost: '~$0.0001 each',
  },
  {
    who: 'Nemotron Ultra 550B',
    model: true,
    what: 'Meaning. What does this change appear to be doing? Reads the diff, never the package.',
    cost: 'only past triage',
  },
  {
    who: 'Tavily',
    what: 'Does the open web know? A changelog, an advisory, or nothing at all — and "nothing at all" about a brand-new host is itself the finding.',
    cost: 'one search',
  },
  {
    who: 'Nemotron Super 120B',
    model: true,
    what: 'Veto. A second model has to agree before anything is accused. One model\'s confident sentence is not a reason to wake somebody at 3am.',
    cost: 'only before an accusation',
  },
];

export default function How({ tree = null }) {
  const still = useReducedMotion();

  /*
   * The one figure in this list that is a measurement rather than a description.
   *
   * It was typed — "14 of 1,214" — and the corpus says fifteen. A number that describes the data
   * has to come from the data, or it is only correct until somebody changes the data, and nothing
   * anywhere says it stopped being correct.
   */
  const steps = STEPS.map((s) =>
    s.cost === null
      ? { ...s, cost: tree ? `${num(tree.moved)} of ${num(tree.total)}` : 'only what moved' }
      : s
  );

  return (
    <section className="wrap" id="how">
      <p className="eyebrow">how it works</p>
      <h2>Nine model calls for a twelve-hundred-package tree</h2>
      <p className="lede">
        Every step below exists to stop the next one from running. That is not an optimisation bolted
        on afterwards — it is the only reason the arithmetic works at all.
      </p>

      <div className="pipe">
        {steps.map((s, i) => (
          <motion.div
            className="step"
            key={s.who}
            data-model={s.model ? 'true' : 'false'}
            /*
             * The step RISES into place. It does not fade in.
             *
             * It used to start at `opacity: 0`, and the six steps that name the three models — the
             * whole pipeline — were found sitting at opacity 0 on the live URL. Chrome had stopped
             * running requestAnimationFrame for that window, so the reveal began and froze: the
             * inline style said 0, `once: true` meant the observer never fired again, and the
             * section was blank to anyone looking at it in a background or occluded window.
             *
             * An animation is allowed to move something. It is not allowed to be the reason
             * something is visible — if it never runs, the reader must still get the page.
             */
            initial={{ y: still ? 0 : 8 }}
            whileInView={{ y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: still ? 0 : 0.4, delay: still ? 0 : Math.min(i * 0.05, 0.3) }}
          >
            <span className="step__who">{s.who}</span>
            <p className="step__what">{s.what}</p>
            <span className="step__cost">{s.cost}</span>
          </motion.div>
        ))}
      </div>

      <div className="coverage" style={{ marginTop: 44 }}>
        <div>
          <h3>Why this could not exist a year ago</h3>
          <p>
            You cannot know what a package does without running it, and nobody could afford to run
            twelve hundred of them in isolation. Forking a live machine now costs a fraction of a
            cent, so the arithmetic changed.
          </p>
        </div>
        <div>
          <h3>And why it is needed now</h3>
          <p>
            npm disabled install scripts by default in July 2026, and within six days an attack
            detonated at <em>import</em> time instead. Reading the source was already behind.
            Watching it run is the only thing that sees this.
          </p>
        </div>
        <div>
          <h3>The model never decides</h3>
          <p>
            Severity is rules, in code, that you can read and re-run. A model explains a finding,
            and a second one has to agree before the tool accuses anybody of anything.
          </p>
        </div>
      </div>
    </section>
  );
}
