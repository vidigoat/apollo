/**
 * What happens when a pull request touches a lockfile.
 *
 *     verify the signature        → 401 if it is not GitHub
 *     is this worth acting on?    → 200 and say why not, for everything else
 *     does the PR touch a lockfile? → one API call to find out; most PRs stop here
 *     read it at the head commit  → the tree as it will be if this merges
 *     ask the index               → free: a lookup, not a sandbox run
 *     post one check run          → drift, unknown, or clean
 *
 * ── Why the index makes this possible at all ────────────────────────────────
 *
 * The expensive version of this product runs every changed dependency in a sandbox on every pull
 * request, which nobody would install twice. The index turns that into a lookup: a package observed
 * once centrally answers for every repository that depends on it, so the hundredth repository costs
 * a file read. That is the whole reason there is an App to build.
 *
 * ── Everything it does not do ───────────────────────────────────────────────
 *
 * It does not install anything, run anything, or execute a line of anybody's code. It reads a
 * lockfile and looks things up. An app that ran untrusted `postinstall` scripts on a pull request
 * from a fork would be a supply-chain attack wearing a security tool's clothes.
 */

const { verify, interesting, checkRun } = require('./webhook');
const { installationToken, filesIn, fileAt, postCheck } = require('./api');
const { parseLockfile, whatMoved } = require('../lockfile');
const { bumpReport } = require('./bump');
const { checkLock } = require('../lock');
const { Index } = require('../index/schema');

/** Lockfiles anywhere in the repository, not only at the root — monorepos are the normal case. */
const IS_LOCKFILE = /(^|\/)package-lock\.json$/;

/**
 * @param {object} req  `{ raw, signature, event, delivery }` — `raw` is the body as received.
 * @param {object} env  `{ appId, privateKey, secret, index }`
 * @param {object} [wired]  the GitHub calls, injected so every decision below can be tested
 *   without an App, a private key, or a network. The calls are not the interesting part; what this
 *   says about somebody's pull request is.
 */
async function handle(req, env, wired = {}) {
  const { installationToken: getToken = installationToken, filesIn: listFiles = filesIn,
          fileAt: getFile = fileAt, postCheck: post = postCheck } = wired;

  const check = verify(req.raw, req.signature, env.secret);
  if (!check.ok) return { status: 401, body: { ok: false, reason: check.why } };

  let body;
  try {
    body = JSON.parse(req.raw);
  } catch {
    return { status: 400, body: { ok: false, reason: 'that was not JSON' } };
  }

  const verdict = interesting(req.event, body);
  if (verdict.pong) return { status: 200, body: { ok: true, pong: true } };
  if (!verdict.act) return { status: 200, body: { ok: true, skipped: verdict.why } };

  const owner = body.repository?.owner?.login;
  const repo = body.repository?.name;
  const number = body.pull_request?.number;
  const sha = body.pull_request?.head?.sha;
  const installationId = body.installation?.id;

  if (!owner || !repo || !number || !sha || !installationId) {
    return { status: 400, body: { ok: false, reason: 'the delivery was missing what it takes to answer' } };
  }

  const token = await getToken({ appId: env.appId, privateKey: env.privateKey, installationId });

  /*
   * The cheap question first. Most pull requests do not touch a lockfile, and for those this costs
   * one API call and posts nothing — a check run saying "no dependencies changed" on every pull
   * request is noise that teaches people to ignore the name.
   */
  const files = await listFiles({ token, owner, repo, number });
  const lockfiles = files.filter((f) => IS_LOCKFILE.test(f));
  if (!lockfiles.length) {
    return { status: 200, body: { ok: true, skipped: 'no lockfile in this pull request' } };
  }

  const index = env.index || new Index();
  if (!index.manifest()) {
    /*
     * Neutral and honest rather than silent. A server with no index cannot answer, and a check run
     * that quietly never appears is indistinguishable from an app that is broken.
     */
    const run = {
      conclusion: 'neutral',
      title: 'no behavioural index on this server',
      summary:
        'This installation has nothing to compare against yet. `npm run index:build` populates it; ' +
        'until then nothing can be claimed about these dependencies either way.',
    };
    await post({ token, owner, repo, sha, run });
    return { status: 200, body: { ok: true, posted: run.conclusion } };
  }

  // The first lockfile, which on a monorepo is the one the PR actually touched most often. A PR
  // that moves several is rare and still gets a real answer about one of them.
  const which = lockfiles[0];
  const text = await getFile({ token, owner, repo, path: which, ref: sha });
  if (!text) {
    return { status: 200, body: { ok: true, skipped: `could not read ${which} at ${sha.slice(0, 7)}` } };
  }

  let tree;
  try {
    ({ versions: tree } = parseLockfile(text));
  } catch (e) {
    return { status: 200, body: { ok: true, skipped: e.message } };
  }

  /*
   * The repository's own apollo.lock if it keeps one, and an empty lock if it does not.
   *
   * With no lock there is nothing to have drifted FROM, so every observed package comes back as
   * "added" and the check reports what the index knows rather than a comparison. That is the right
   * first experience: install the app, open a PR, and see how much of your tree is already known.
   */
  const lockPath = which.replace(/package-lock\.json$/, 'apollo.lock');
  const lockText = await getFile({ token, owner, repo, path: lockPath, ref: sha });

  let lock = { packages: {} };
  if (lockText) {
    try {
      lock = JSON.parse(lockText);
    } catch {
      lock = { packages: {} };
    }
  }

  const result = checkLock(lock, tree, index);

  /*
   * What the pull request upgrades: the same lockfile at the base commit, against the head.
   *
   * One more read, and only for a pull request that already touched a lockfile. A base that cannot
   * be read or parsed — a new lockfile, a first commit — means there is nothing to have upgraded
   * FROM, and the lock verdict stands on its own exactly as before.
   */
  let bumps = null;
  const baseSha = body.pull_request?.base?.sha;
  if (baseSha) {
    try {
      const baseText = await getFile({ token, owner, repo, path: which, ref: baseSha });
      if (baseText) {
        const moved = whatMoved(parseLockfile(baseText), { versions: tree }).moved;
        if (moved.length) bumps = bumpReport(moved, { index, ledger: env.ledger || null });
      }
    } catch { bumps = null; }
  }

  const run = checkRun(result, { total: tree.size, bumps });
  await post({ token, owner, repo, sha, run });

  return {
    status: 200,
    body: {
      ok: true,
      posted: run.conclusion,
      checked: result.checked,
      drift: result.drift.length,
      unknown: result.unknown.length,
      upgrades: bumps ? { changed: bumps.changed.length, same: bumps.same.length, unknown: bumps.unknown.length } : null,
      lockfile: which,
    },
  };
}

module.exports = { handle, IS_LOCKFILE };
