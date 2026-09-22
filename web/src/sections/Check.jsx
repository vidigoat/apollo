import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

/**
 * The answer, where the decision is actually made.
 *
 * `stakeout check` already answers this in CI, which is the right place for it and also the place
 * nobody looks until it is too late. The GitHub App puts the same answer on the pull request that
 * bumps the dependency, next to the diff, while somebody still has their hand on it.
 *
 * ── Three outcomes, and none of them is a plain pass ────────────────────────
 *
 * The switch below is not a feature tour. It is the argument: an unknown package is NEUTRAL, never
 * a failure. On any real tree most packages start unknown, and a check that goes red on day one is
 * a check somebody disables in week one — and then the day it has something real to say, nobody is
 * listening. The text in each panel is the text the App posts, from github/webhook.js.
 */

const OUTCOMES = [
  {
    key: 'drift',
    tab: 'drift',
    conclusion: 'failure',
    mark: '✕',
    title: '1 dependency behaves differently',
    body: ['The version did not move. The behaviour did.'],
    // The finding itself, as the App posts it: the package, then what it started doing.
    finding: {
      pkg: 'express-fileupload@2.1.1',
      what: 'env: now AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, NPM_TOKEN · net: now cdn-assets-delivery.workers.dev',
    },
    foot: '412 packages were checked against the lock.',
  },
  {
    key: 'unknown',
    tab: 'never observed',
    conclusion: 'neutral',
    mark: '—',
    title: '389 checked, 23 never observed',
    body: [
      'No dependency in this pull request behaves differently than the lock records.',
      '23 of them have never been observed by anything, so nothing is claimed about those.',
    ],
    foot: 'That is the normal state of a dependency tree, not a finding. Run `npx stakeout index --from-lockfile package-lock.json` to shrink it.',
  },
  {
    key: 'clean',
    tab: 'clean',
    conclusion: 'success',
    mark: '✓',
    title: '412 of 412 packages behave as recorded',
    body: [
      'Every package in this tree was observed, and none of them does anything it did not do before.',
    ],
    foot: 'Behaviour is compared, not versions. A patch release that quietly starts reading an environment variable would fail this check with its version unchanged.',
  },
];

export default function Check() {
  const [which, setWhich] = useState('drift');
  const still = useReducedMotion();
  const shown = OUTCOMES.find((o) => o.key === which);

  return (
    <section className="wrap" id="check">
      <p className="eyebrow">on the pull request</p>
      <h2>A check run that never says "passed" about something it has not seen</h2>
      <p className="lede">
        A GitHub App, authenticating as an app rather than as somebody's personal token — a
        signed JWT exchanged for a token scoped to one installation, expiring in an hour. It reads
        the lockfile at the head commit and asks the index. It installs nothing and executes no
        one's code, which for a supply-chain tool is not a detail.
      </p>

      <div className="tabs" role="tablist" aria-label="what the check says">
        {OUTCOMES.map((o) => (
          <button
            key={o.key}
            className="tab"
            role="tab"
            aria-selected={which === o.key}
            data-state={which === o.key ? 'active' : 'idle'}
            onClick={() => setWhich(o.key)}
          >
            {o.tab}
          </button>
        ))}
      </div>

      <div className="check" data-conclusion={shown.conclusion}>
        <AnimatePresence mode="wait">
          <motion.div
            key={shown.key}
            initial={{ opacity: 0, y: still ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: still ? 0 : -6 }}
            transition={{ duration: still ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="check__head">
              <span className="check__mark" aria-hidden="true">
                {shown.mark}
              </span>
              <span className="check__name">stakeout</span>
              <span className="check__title">{shown.title}</span>
              <span className="check__conclusion">{shown.conclusion}</span>
            </div>
            <div className="check__body">
              {shown.body.map((line) => (
                <p key={line}>{line}</p>
              ))}

              {shown.finding && (
                <p className="check__finding">
                  <b>{shown.finding.pkg}</b>
                  <span>{shown.finding.what}</span>
                </p>
              )}

              {shown.foot && <p className="check__foot">{shown.foot}</p>}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <p className="lede">
        The middle one is the important one. Unknown is <b>neutral</b>, never a failure — a check
        that red-lights on the day it is installed is switched off before it ever finds anything.
      </p>
    </section>
  );
}
