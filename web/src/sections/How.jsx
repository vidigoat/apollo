import { motion, useReducedMotion } from 'motion/react';

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
    cost: '14 of 1,214',
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

export default function How() {
  const still = useReducedMotion();

  return (
    <section className="wrap" id="how">
      <p className="eyebrow">how it works</p>
      <h2>Nine model calls for a twelve-hundred-package tree</h2>
      <p className="lede">
        Every step below exists to stop the next one from running. That is not an optimisation bolted
        on afterwards — it is the only reason the arithmetic works at all.
      </p>

      <div className="pipe">
        {STEPS.map((s, i) => (
          <motion.div
            className="step"
            key={s.who}
            data-model={s.model ? 'true' : 'false'}
            initial={{ opacity: still ? 1 : 0, y: still ? 0 : 8 }}
            whileInView={{ opacity: 1, y: 0 }}
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
