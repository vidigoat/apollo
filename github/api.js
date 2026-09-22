/**
 * Talking to GitHub as an App, with nothing installed.
 *
 * A GitHub App authenticates in two hops and both of them matter:
 *
 *   1. sign a JWT with the app's private key        proves you are the app
 *   2. exchange it for an installation token        proves you may touch THIS repository
 *
 * The second hop is the one that makes an App better than a personal token. The installation token
 * is scoped to one installation, expires in an hour, and cannot reach a repository the owner did
 * not grant. A PAT pasted into CI can read every repository its owner can, forever, and that is
 * the thing this project would be embarrassed to ship.
 *
 * ── No dependencies, still ──────────────────────────────────────────────────
 *
 * Signing an RS256 JWT is three base64url segments and one `crypto.sign`. The usual library for it
 * pulls in a dependency tree, which for a tool whose entire argument is about dependency trees
 * would be funny in the wrong way.
 */

const crypto = require('node:crypto');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A JWT that proves we are the app.
 *
 * `iat` is backdated sixty seconds on purpose: GitHub rejects a token issued in the future, and
 * two machines' clocks are never quite the same. Ten minutes is the maximum GitHub accepts and
 * there is no reason to ask for less — the token is used once, immediately, to get the real one.
 */
function appJwt({ appId, privateKey, now = Date.now() }) {
  if (!appId || !privateKey) throw new Error('the app id and private key are both required');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));

  /*
   * Ten minutes measured from `iat`, not from now — the backdating counts against the budget.
   * `iat - 60` with `exp = now + 600` is a 660-second span, which GitHub rejects outright, and
   * the 401 it answers with does not say which of the two clocks it disliked.
   */
  const iat = Math.floor(now / 1000) - 60;
  const claims = b64url(JSON.stringify({
    iat,
    exp: iat + 600,
    iss: String(appId),
  }));

  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Every request to GitHub goes through here, so the headers are right in one place. */
async function call(path, { token, method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'stakeout',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    /*
     * The status and GitHub's own message, not a generic failure. Every one of these means
     * something different and actionable — 401 is a bad key, 403 is a missing permission the app
     * has to be granted by its owner, 404 from an installation token means this repository is not
     * one of the ones it was installed on.
     */
    throw new Error(`GitHub ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** An hour-long token scoped to one installation. */
async function installationToken({ appId, privateKey, installationId }) {
  const jwt = appJwt({ appId, privateKey });
  const out = await call(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: 'POST',
  });
  return out.token;
}

/**
 * One file, at one commit.
 *
 * `raw` rather than the JSON envelope: a package-lock.json is megabytes and base64 in a JSON
 * wrapper is a third bigger again, for no reason.
 */
async function fileAt({ token, owner, repo, path, ref }) {
  try {
    const text = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          accept: 'application/vnd.github.raw+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'stakeout',
        },
      }
    ).then((r) => (r.ok ? r.text() : null));
    return text;
  } catch {
    return null;
  }
}

/** Which files a pull request touches — so a PR that leaves the lockfile alone costs one call. */
async function filesIn({ token, owner, repo, number }) {
  const out = await call(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, { token });
  return (out || []).map((f) => f.filename);
}

/** Post the verdict where the decision is being made. */
async function postCheck({ token, owner, repo, sha, run }) {
  return call(`/repos/${owner}/${repo}/check-runs`, {
    token,
    method: 'POST',
    body: {
      name: 'stakeout',
      head_sha: sha,
      status: 'completed',
      conclusion: run.conclusion,
      completed_at: new Date().toISOString(),
      output: { title: run.title, summary: run.summary },
    },
  });
}

module.exports = { appJwt, call, installationToken, fileAt, filesIn, postCheck, b64url };
