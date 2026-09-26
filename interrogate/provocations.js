/**
 * The provocations — the fixed catalogue of environments a package can be watched under.
 *
 * A package that wants to steal does it when it thinks the coast is right: on a CI runner where a
 * publish token is lying in the environment, on a developer's box with cloud credentials, near a
 * crypto wallet, after a dormancy date has passed. Observed in a bare sandbox it does nothing, and
 * reports clean. So instead of observing it once, it is observed under each of these — and anything
 * it does under one that it did not do bare is the thing it was hiding.
 *
 * Two rules make this safe, and they are the whole reason it is data and not code:
 *
 *   1. Every value here is a DECOY. `NPM_TOKEN` is not a real token, the AWS key is the AWS
 *      documentation's own example key, the wallet is an empty file. Nothing here grants access to
 *      anything. What is watched for is the ATTEMPT to read and send them, never a real secret.
 *
 *   2. A provocation is a set of environment variables and empty planted files — DATA. The
 *      interrogation runs every package under the SAME probe as the normal watch, in CONTAINED mode
 *      (observe/probe.js: a network attempt is recorded and never forwarded). The model chooses
 *      which provocations are worth trying and says why; it never writes anything that executes.
 *
 * A planted file is a path and a short content. The honeytoken value carries a fixed, searchable
 * marker so that if it ever shows up in a network attempt's recorded payload, that is proof the
 * package read the decoy and tried to send it — caught in the one place it thought no one was
 * looking.
 */

// The one string that appears in every decoy, so a stolen decoy is unmistakable if it surfaces.
const CANARY = 'ST4KE0UT-CANARY';

const PROVOCATIONS = [
  {
    id: 'bare',
    why: 'the baseline: a plain sandbox, nothing planted. What a package does here is its honest behaviour.',
    env: {},
    files: {},
  },
  {
    id: 'ci-with-npm-token',
    why: 'a CI runner mid-publish, with an npm token in the environment — where a self-publishing worm or a token stealer strikes.',
    env: {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      NPM_TOKEN: `npm_${CANARY}000000000000000000000000`,
      NODE_AUTH_TOKEN: `npm_${CANARY}000000000000000000000000`,
    },
    files: {},
  },
  {
    id: 'cloud-creds',
    why: "a developer's machine with cloud credentials present, the target of most real credential stealers.",
    env: {
      AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      // AWS's own documentation example secret; not a live key.
      AWS_SECRET_ACCESS_KEY: `wJalrXUtnFEMI/K7MDENG/bPxRfiCY${CANARY}`,
    },
    files: {
      '.aws/credentials': `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/${CANARY}\n`,
    },
  },
  {
    id: 'crypto-wallet',
    why: 'a machine with a crypto wallet, which clipboard-swappers and wallet-drainers look for by path.',
    env: {},
    files: {
      '.config/solana/id.json': `[${CANARY.split('').map((c) => c.charCodeAt(0)).join(',')}]`,
      '.electrum/wallets/default_wallet': `{"seed":"${CANARY} decoy only"}`,
    },
  },
  {
    id: 'clock-forward',
    why: 'time moved months ahead, to trip a payload that waits for a dormancy date before it acts.',
    // Read by the probe's clock shim, not the real system clock — a package that checks `Date.now()`
    // sees the future; nothing on the box actually changes.
    env: { STAKEOUT_CLOCK_OFFSET_DAYS: '120' },
    files: {},
  },
];

module.exports = { PROVOCATIONS, CANARY };
