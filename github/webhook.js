/**
 * The GitHub App's front door.
 *
 * A webhook endpoint is a URL on the open internet that anybody can POST to, and this one decides
 * what a check run says about somebody's pull request. So the first thing in this file is the
 * signature check, it happens before the body is parsed into anything meaningful, and it is
 * constant-time.
 *
 * ── What this app is for ────────────────────────────────────────────────────
 *
 * `apollo check` already answers the question in CI. That is the right place for it and it is
 * also the place nobody looks until it is too late. The App puts the same answer where the
 * decision is actually made — on the pull request that bumps a dependency, next to the diff, while
 * somebody still has their hand on it.
 *
 *     PR touches package-lock.json
 *        → read the lockfile at the head commit
 *        → ask the behavioural index what each package did
 *        → one check run: clean, drift, or honestly unknown
 *
 * ── The three outcomes, and why none of them is "pass" ──────────────────────
 *
 *   drift      a version that did not move now behaves differently. The finding. `failure`.
 *   unknown    packages the index has never observed. NOT a failure — that is the normal state of
 *              a dependency tree, and a check that red-lights on day one gets switched off before
 *              it ever finds anything. `neutral`, with the count and the names.
 *   clean      every package in the tree was observed and none of them drifted. `success`, and it
 *              says how many were checked so the number can be argued with.
 *
 * A check run that says "passed" over a tree the index has never seen would be the single most
 * dishonest thing this project could ship.
 */

const crypto = require('node:crypto');

/**
 * Was this really sent by GitHub?
 *
 * `crypto.timingSafeEqual` rather than `===`, because a string comparison that returns early leaks
 * how much of the signature was right, and a few thousand requests turn that into a forged one.
 * Both buffers have to be the same length for it not to throw, so the length is checked first —
 * and a wrong length is a wrong signature anyway.
 *
 * @param {string|Buffer} raw   the body EXACTLY as received. Re-serialising a parsed object
 *   changes whitespace and key order and the signature stops matching, which is a whole afternoon
 *   if you have not met it before.
 */
function verify(raw, signature, secret) {
  if (!secret) return { ok: false, why: 'no webhook secret is configured on this server' };
  if (!signature) return { ok: false, why: 'no signature header' };

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return { ok: false, why: 'signature is the wrong length' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, why: 'signature does not match' };
  return { ok: true };
}

/**
 * Which events this app acts on, and which it politely ignores.
 *
 * GitHub sends a lot that is not interesting, and an app that treats every delivery as work is an
 * app that rate-limits itself. `ping` is answered because GitHub sends it to prove the endpoint is
 * alive, and a 404 there makes the app look broken in its own settings page.
 */
const ACTS_ON = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

function interesting(event, body) {
  if (event === 'ping') return { act: false, pong: true };
  if (event !== 'pull_request') return { act: false, why: `nothing to do for a ${event} event` };
  if (!ACTS_ON.has(body?.action)) return { act: false, why: `nothing to do for ${body?.action}` };
  if (body?.pull_request?.draft) return { act: false, why: 'draft pull requests are left alone' };
  return { act: true };
}

/**
 * The check run, from a `checkLock` result.
 *
 * Separated from everything that talks to the network so the decision — what this SAYS about
 * somebody's pull request — can be tested without a GitHub App, a private key, or an internet
 * connection. That decision is the part worth being sure about.
 *
 * @param {object} result  from lock.js `checkLock`
 * @param {object} meta    `{ total }` — how many packages were in the tree
 */
function checkRun(result, { total, bumps = null } = {}) {
  const run = lockRun(result, { total });
  return bumps ? withBumps(run, bumps) : run;
}

/**
 * The upgrades, laid over the lock verdict.
 *
 * A pull request from a dependency bot moves versions, and the lock check has nothing to say about
 * a version that moved — it is "added", recorded rather than compared. This is the other half: for
 * each package the pull request upgrades, whether the new release behaves like the one it replaces.
 *
 * Red only for what the rules call notable or alarming. A release that starts reading NO_COLOR is
 * a change worth a line and not worth a red check; a check that goes red on every colour library
 * is one somebody turns off before the release that matters.
 */
function withBumps(run, bumps) {
  const { changed = [], same = [], unknown = [] } = bumps;
  if (!changed.length && !same.length && !unknown.length) return run;
  const { evidence } = require('./bump');
  const loud = changed.filter((c) => c.severity === 'alarming' || c.severity === 'notable');

  const lines = changed.slice(0, 15).map((c) => {
    const ev = evidence(c.gained).map((l) => `  - ${l}`);
    return [`- **${c.pkg}** ${c.from} → ${c.to} — ${c.severity}: ${(c.reasons || []).join('; ') || 'behaviour changed'}`, ...ev,
      ...(c.explained ? [`  - what that is: ${c.explained}`] : []), `  - _${c.source}_`].join('\n');
  });
  const parts = ['### What this pull request upgrades'];
  if (lines.length) parts.push(`${changed.length === 1 ? 'One upgrade does' : `${changed.length} upgrades do`} something the version it replaces did not:\n\n${lines.join('\n')}` + (changed.length > 15 ? `\n\n…and ${changed.length - 15} more.` : ''));
  if (same.length) parts.push(`**${same.length}** upgrade${same.length === 1 ? ' was' : 's were'} compared and behave${same.length === 1 ? 's' : ''} the same as before: ${same.slice(0, 12).map((x) => `${x.pkg} ${x.to}`).join(', ')}${same.length > 12 ? `, and ${same.length - 12} more` : ''}.`);
  if (unknown.length) {
    parts.push(`**${unknown.length}** upgrade${unknown.length === 1 ? ' has' : 's have'} not been compared by anything, so nothing is claimed about ${unknown.length === 1 ? 'it' : 'them'}:\n\n` +
      unknown.slice(0, 12).map((u) => `- ${u.pkg} ${u.from} → ${u.to}${u.nearest ? ` — ${u.to} itself was watched against ${u.nearest.against}: ${u.nearest.severity}${u.nearest.reasons.length ? ` (${u.nearest.reasons.join('; ')})` : ''}` : ''}`).join('\n') +
      (unknown.length > 12 ? `\n- …and ${unknown.length - 12} more` : ''));
  }
  if (loud.length) parts.push('"Alarming" means *read this before merging*, never *this is malicious*. The lines above are what was observed; the judgement is yours.');

  const n = loud.length;
  const bumpTitle = `${n} upgrade${n === 1 ? ' behaves' : 's behave'} differently than the version ${n === 1 ? 'it replaces' : 'they replace'}`;
  let { conclusion, title } = run;
  if (n) {
    title = conclusion === 'failure' ? `${title}, and ${bumpTitle}` : bumpTitle;
    conclusion = 'failure';
  } else if (changed.length && conclusion === 'success') {
    conclusion = 'neutral';
    title = `${changed.length} upgrade${changed.length === 1 ? '' : 's'} changed behaviour in a small way`;
  }
  return { conclusion, title, summary: `${parts.join('\n\n')}\n\n---\n\n### Against the lock\n\n${run.summary}` };
}

function lockRun(result, { total } = {}) {
  const { drift = [], unknown = [], added = [], checked = 0 } = result || {};

  if (drift.length) {
    const lines = drift.slice(0, 20).map((d) => {
      const what = (d.changes || [])
        .map((c) => {
          const gained = (c.after || []).filter((x) => !(c.before || []).some((y) => same(x, y)));
          // Install-time drift says so in words: "at install, env", not the key "install.env".
          const where = String(c.channel).startsWith('install.') ? `at install, ${c.channel.slice(8)}` : c.channel;
          return gained.length
            ? `${where}: now ${gained.map(describe).join(', ')}`
            : `${where}: no longer ${(c.before || []).map(describe).join(', ')}`;
        })
        .join('  ·  ');
      return `- **${d.package}** — ${what}`;
    });

    return {
      conclusion: 'failure',
      title: `${drift.length} dependenc${drift.length === 1 ? 'y behaves' : 'ies behave'} differently`,
      summary:
        `The version did not move. The behaviour did.\n\n${lines.join('\n')}` +
        (drift.length > 20 ? `\n\n…and ${drift.length - 20} more.` : '') +
        `\n\n${checked} package${checked === 1 ? '' : 's'} were checked against the lock.`,
    };
  }

  if (unknown.length) {
    /*
     * Neutral, not failure, and this is the most important line in the file.
     *
     * On any real tree most packages start unknown. A check that goes red on day one is a check
     * somebody disables in week one, and then the day it has something real to say, nobody is
     * listening. It says what it does not know, by name, and gets out of the way.
     */
    const shown = unknown.slice(0, 15);
    return {
      conclusion: 'neutral',
      title: `${checked} checked, ${unknown.length} never observed`,
      summary:
        `No dependency in this pull request behaves differently than the lock records.\n\n` +
        `**${unknown.length}** of them have never been observed by anything, so nothing is claimed ` +
        `about those:\n\n${shown.map((u) => `- ${u}`).join('\n')}` +
        (unknown.length > shown.length ? `\n- …and ${unknown.length - shown.length} more` : '') +
        `\n\nThat is the normal state of a dependency tree, not a finding. Run ` +
        '`npx apollo index --from-lockfile package-lock.json` to shrink it.',
    };
  }

  return {
    conclusion: 'success',
    title: `${checked} of ${total ?? checked} packages behave as recorded`,
    summary:
      `Every package in this tree was observed, and none of them does anything it did not do ` +
      `before.\n\n${added.length ? `${added.length} are new since the lock was written, and are ` +
      `recorded rather than compared — there is no previous behaviour to have drifted from.\n\n` : ''}` +
      'Behaviour is compared, not versions. A patch release that quietly starts reading an ' +
      'environment variable would fail this check with its version unchanged.',
  };
}

/** One observation, in the fewest words that still identify it. */
function describe(x) {
  if (!x || typeof x !== 'object') return String(x);
  if (x.host) return `${x.host}${x.port && x.port !== 443 ? `:${x.port}` : ''}`;
  if (x.name) return x.name;
  if (x.path) return x.path;
  return JSON.stringify(x);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = { verify, interesting, checkRun, describe };
