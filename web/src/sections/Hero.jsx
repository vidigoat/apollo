import { m, useReducedMotion } from "motion/react";

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
      {/*
        The words are THERE. They do not fade in.

        The first version staggered the mark, the headline and the paragraph over about a second,
        so the first thing anybody saw on the live URL was a blank dark screen. A page that
        withholds its own headline to make an entrance has made the entrance the point. The
        orchestrated moment is the evidence arriving underneath a version that did not move; the
        sentence explaining it has no business being suspense.
      */}
      <div className="hero__said">
        <p className="hero__mark">Stakeout</p>

        <h1>
          Your lockfile pins versions.
          <span className="quiet">This pins behaviour.</span>
        </h1>

        <p className="hero__sub">
          Every dependency gets its own disposable copy of your machine. We install it, import it,
          and write down what it actually did — then do the same with the version you had before,
          from the identical starting state, and show you what changed.
        </p>

        <p className="hero__scroll">
          from the bundled corpus — planted, labelled as planted, reproducible with{' '}
          <code>npm run demo</code>
        </p>
      </div>

      <div className="exhibit">
        {ROWS.map((r) => (
          <div className="exhibit__row exhibit__row--was" key={r.text}>
            <span className="exhibit__gutter">{r.gutter}</span>
            <span>{r.text}</span>
            <span className="exhibit__when">{r.when}</span>
          </div>
        ))}

        {/* What the space says while it is being looked at, rather than nothing. */}
        {!still && <m.span
          className="exhibit__watching"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.1, delay: 0.2, times: [0, 0.2, 0.7, 1] }}
        >
          watching
        </m.span>}

        {/* The look. One pass, top to bottom, and then it is gone. */}
        {!still && (
          <m.span
            className="exhibit__scan"
            initial={{ top: 0, opacity: 0 }}
            animate={{ top: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.8, delay: 0.15, ease: "easeInOut" }}
          />
        )}

        {FOUND.map((f, i) => (
          <m.div
            className="exhibit__row exhibit__row--found"
            key={f.what}
            initial={{ opacity: 0, x: still ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.34, delay: at(0.62 + i * 0.09) }}
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
          </m.div>
        ))}

        <m.div
          className="exhibit__verdict"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: at(1.02) }}
        >
          <span>
            a patch release that now reads three credentials and calls a host{" "}
            <b>nothing on the open web mentions</b>
          </span>
        </m.div>
      </div>
    </section>
  );
}
