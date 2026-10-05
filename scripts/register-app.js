#!/usr/bin/env node
/**
 * Register the GitHub App.
 *
 *   node scripts/register-app.js [--webhook https://…/api/github/webhook]
 *
 * ── Why this script exists ──────────────────────────────────────────────────
 *
 * `gh` cannot create a GitHub App. There is no REST endpoint for it — GitHub allows exactly two
 * routes, filling in the web form by hand, or the *manifest flow*, which is this one:
 *
 *     1. this script starts a one-request server on localhost
 *     2. it opens a page that POSTs a manifest — name, permissions, events, webhook URL — to
 *        github.com/settings/apps/new
 *     3. a human presses "Create GitHub App". Nothing is created before that press.
 *     4. GitHub redirects back here with a temporary code, good for one hour
 *     5. the code is exchanged for the app id, the private key, and the webhook secret
 *
 *     6. the app id, key and secret are written to `.env`, pushed to the live deployment's
 *        production environment, and the deployment is rebuilt so it picks them up
 *
 * The exchange happens once and the credentials are never shown again, so they are written
 * straight to `.env`, which is gitignored and in `.vercelignore`.
 *
 * Step 6 is not a convenience. Without it the moment after registration is a live App pointed at
 * an endpoint that 401s everything it sends — `no webhook secret is configured on this server` —
 * and nothing anywhere saying a step was missing. A registration flow that leaves the thing it
 * registered non-functional is not a registration flow.
 *
 * ── What it asks for, and what it deliberately does not ─────────────────────
 *
 *   contents: read      to read package-lock.json at the head commit
 *   pull_requests: read to see which files a pull request touches
 *   checks: write       to post one check run
 *   metadata: read      mandatory; GitHub adds it regardless
 *
 * No write access to anybody's code, no access to secrets, no organisation permissions, no `email`
 * scope. A supply-chain tool asking for more than it needs is a supply-chain risk wearing a
 * security tool's clothes, and this list is short enough to read on the install screen.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg('port', 8799));
const WEBHOOK = arg('webhook', 'https://apollo-watch.vercel.app/api/github/webhook');
const HOME = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

/** One place the app is described, so the install screen and the README cannot disagree. */
const manifest = {
  name: arg('name', 'stakeout-behaviour'),
  url: 'https://github.com/vidigoat/apollo',
  hook_attributes: { url: WEBHOOK, active: true },
  redirect_url: `${HOME}/created`,
  description:
    'Checks whether a dependency in this pull request behaves differently than the version it ' +
    'replaces — including when the version did not move. Reads the lockfile; installs nothing ' +
    'and runs nobody\'s code.',
  public: true,
  default_events: ['pull_request'],
  default_permissions: {
    contents: 'read',
    pull_requests: 'read',
    checks: 'write',
    metadata: 'read',
  },
};

const page = (state) => `<!doctype html>
<meta charset="utf-8">
<title>Register the app</title>
<style>
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; background: #0a0f14; color: #e6eaf0;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  form { text-align: center; }
  button { font: 500 15px system-ui; padding: 14px 22px; border-radius: 3px; border: 0;
           background: #e6eaf0; color: #0a0f14; cursor: pointer; }
  p { color: #7f8d9c; max-width: 44ch; }
  code { color: #82b4c2; font-size: 13px; }
</style>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
  <p>This hands the manifest below to GitHub. Nothing is created until you press
     <b>Create GitHub App</b> on GitHub's own page.</p>
  <p><code>${WEBHOOK}</code></p>
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&apos;')}'>
  <button type="submit">Take me to GitHub</button>
</form>
<script>document.forms[0].submit()</script>`;

const done = (title, body) => `<!doctype html>
<meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0a0f14;color:#e6eaf0;
display:grid;place-items:center;height:100vh;margin:0;text-align:center}
p{color:#7f8d9c;max-width:52ch}code{color:#82b4c2}</style>
<h1 style="font-weight:600">${title}</h1><p>${body}</p>`;

const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, HOME);

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(state));
  }

  if (url.pathname !== '/created') {
    res.writeHead(404);
    return res.end('no');
  }

  // The state is ours and came back unchanged, or this redirect is not the one we started.
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(done('That redirect did not come from this run', 'Nothing was written.'));
    return finish(1, 'the state did not match');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(done('GitHub sent no code', 'Nothing was written.'));
    return finish(1, 'no code in the redirect');
  }

  try {
    /*
     * The one-shot exchange. The private key and the webhook secret come back here and are never
     * retrievable again — GitHub will let you generate a NEW key later, but this response is the
     * only time this one exists.
     */
    const out = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'apollo',
        'x-github-api-version': '2022-11-28',
      },
    }).then(async (r) => {
      const text = await r.text();
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    });

    write(out);
    const live = publish(out);

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      done(
        `${out.name} is registered`,
        `App id <code>${out.id}</code>. The key and secret were written to <code>.env</code> and ` +
          `${live ? 'pushed to the live deployment, which has been rebuilt' : '<b>not</b> pushed to the deployment — see the terminal'}. ` +
          `Install it at <code>${out.html_url}/installations/new</code>.`
      )
    );
    finish(0, `${out.name} (${out.id}) — install it at ${out.html_url}/installations/new`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(done('The exchange failed', e.message));
    finish(1, e.message);
  }
});

/**
 * The same three values, onto the deployment.
 *
 * ── Why this is here and not left as a manual step ──────────────────────────
 *
 * Writing `.env` makes the App work on this laptop. The webhook GitHub will actually call is the
 * one on the demo URL, and that process has none of these — so without this, the moment after
 * registration is a live App pointed at an endpoint that answers 401 to everything it sends, with
 * `no webhook secret is configured on this server` as the reason, and nothing anywhere saying that
 * one more step was needed.
 *
 * A registration flow that leaves the thing it registered non-functional is not a registration
 * flow. So the three values go to the production environment and the deployment is rebuilt to pick
 * them up, and if any of that fails it is reported rather than swallowed — a half-configured
 * webhook is worse than an unconfigured one, because it looks finished.
 */
function publish(app) {
  const env = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    GITHUB_PRIVATE_KEY: app.pem,
  };

  try {
    for (const [name, value] of Object.entries(env)) {
      // Replace rather than duplicate: a second value for the same name is a coin toss.
      spawnSync('npx', ['vercel', 'env', 'rm', name, 'production', '--yes'], {
        cwd: ROOT, stdio: 'ignore',
      });
      const put = spawnSync('npx', ['vercel', 'env', 'add', name, 'production'], {
        cwd: ROOT, input: value, encoding: 'utf8',
      });
      if (put.status !== 0) throw new Error(`could not set ${name}: ${(put.stderr || '').trim().slice(0, 160)}`);
    }

    // Environment variables are read at build time, so the running deployment has to be replaced.
    const deploy = spawnSync('npx', ['vercel', '--prod', '--yes'], { cwd: ROOT, encoding: 'utf8' });
    if (deploy.status !== 0) throw new Error(`deployed variables, but the redeploy failed: ${(deploy.stderr || '').trim().slice(0, 160)}`);

    console.log('  the live webhook now has the key and the secret, and has been redeployed');
    return true;
  } catch (e) {
    console.log(`\n  ${e.message}`);
    console.log('  The app IS registered and .env is written — only the deployment is behind.');
    console.log('  Fix with: npx vercel env add GITHUB_APP_ID production   (and the other two)\n');
    return false;
  }
}

/**
 * Credentials to `.env`, and never to stdout.
 *
 * An existing value is never overwritten silently — a second run that quietly replaced a working
 * app's key would break an installation somebody had already granted, and the only symptom would
 * be 401s on a webhook nobody is watching.
 */
function write(app) {
  const file = path.join(ROOT, '.env');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (/^GITHUB_APP_ID=/m.test(before)) {
    const keep = path.join(ROOT, `.env.app-${app.id}`);
    fs.writeFileSync(keep, env(app), { mode: 0o600 });
    console.log(`\n  An app is already configured in .env, so this one went to ${path.basename(keep)}.`);
    return;
  }

  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${env(app)}`, {
    mode: 0o600,
  });
}

const env = (app) =>
  [
    '',
    `# The GitHub App, registered ${new Date().toISOString().slice(0, 10)} by scripts/register-app.js.`,
    '# The private key and the secret below were returned exactly once and cannot be fetched again.',
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
    `GITHUB_PRIVATE_KEY="${app.pem.replace(/\n/g, '\\n')}"`,
    '',
  ].join('\n');

function finish(code, why) {
  console.log(code === 0 ? `\n  ${why}\n` : `\n  failed: ${why}\n`);
  server.close();
  setTimeout(() => process.exit(code), 250);
}

server.listen(PORT, () => {
  console.log(`\n  Open ${HOME} and press the button on GitHub's page.`);
  console.log(`  Webhook: ${WEBHOOK}\n`);
});
