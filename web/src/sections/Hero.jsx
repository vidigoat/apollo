import { motion, useReducedMotion } from "motion/react";

/**
 * The first screen.
 *
 * Not a description of the product — the product, performed once. Two lines of a lockfile, one
 * patch release apart, and then the evidence that arrived underneath the second one. Somebody who
 * reads nothing else on this page has still seen the entire idea.
 *
 * This is the only thing on the site that moves without being asked, and it happens once. The scan
 * line is not decoration: it is the moment of looking, which is the thing being sold.
 *
 * Every string below is from the bundled corpus, which is planted, labelled as planted in the
 * repository, and reproducible with `npm run demo`. A first screen that invented a finding would
 * be the exact kind of thing this project exists to catch.
 */

const ROWS = [
  {
    gutter: " ",
    text: "express-fileupload@2.1.0",
    when: "your lockfile, 14 Aug",
  },
  { gutter: " ", text: "express-fileupload@2.1.1", when: "the patch release" },
];

const FOUND = [
  { channel: "env", what: "AWS_SECRET_ACCESS_KEY" },
  { channel: "env", what: "GITHUB_TOKEN" },
  { channel: "env", what: "NPM_TOKEN" },
  { channel: "net", what: "cdn-assets-delivery.workers.dev:443" },
];

export default function Hero() {
  const still = useReducedMotion();

  // With motion turned off the evidence is simply there. The point survives without the sweep;
  // it is the sweep that is optional, not the finding.
  const at = (s) => (still ? 0 : s);

  return (
    <section className="hero wrap" id="top">
      <div className="hero__said">
        <motion.p
          className="hero__mark"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          Stakeout
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: still ? 0 : 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.7,
            ease: [0.16, 1, 0.3, 1],
            delay: at(0.1),
          }}
        >
          Your lockfile pins versions.
          <span className="quiet">This pins behaviour.</span>
        </motion.h1>

        <motion.p
          className="hero__sub"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: at(0.35) }}
        >
          Every dependency gets its own disposable copy of your machine. We
          install it, import it, and write down what it actually did — then do
          the same with the version you had before, from the identical starting
          state, and show you what changed.
        </motion.p>

        <motion.p
          className="hero__scroll"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: at(2.7) }}
        >
          from the bundled corpus — planted, labelled as planted, reproducible
          with <code>npm run demo</code>
        </motion.p>
      </div>

      <motion.div
        className="exhibit"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: at(0.55) }}
      >
        {ROWS.map((r) => (
          <div className="exhibit__row" key={r.text}>
            <span className="exhibit__gutter">{r.gutter}</span>
            <span>{r.text}</span>
            <span className="exhibit__when">{r.when}</span>
          </div>
        ))}

        {/* The look. One pass, top to bottom, and then it is gone. */}
        {!still && (
          <motion.span
            className="exhibit__scan"
            initial={{ top: 0, opacity: 0 }}
            animate={{ top: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.1, delay: 0.95, ease: "easeInOut" }}
          />
        )}

        {FOUND.map((f, i) => (
          <motion.div
            className="exhibit__row exhibit__row--found"
            key={f.what}
            initial={{ opacity: 0, x: still ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: at(1.75 + i * 0.13) }}
          >
            <span className="exhibit__gutter">+</span>
            <span>
              {f.channel}
              {"   "}
              {f.what}
            </span>
            <span className="exhibit__when">
              {i === 0 ? "not in 2.1.0" : ""}
            </span>
          </motion.div>
        ))}

        <motion.div
          className="exhibit__verdict"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: at(2.4) }}
        >
          <span>
            a patch release that now reads three credentials and calls a host{" "}
            <b>nothing on the open web mentions</b>
          </span>
        </motion.div>
      </motion.div>
    </section>
  );
}
