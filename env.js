/**
 * Load `.env`, without a dependency.
 *
 * Node 20.6+ can do this with `--env-file=.env`, and that is the better mechanism — but it has to
 * be on every command line, and the first thing a judge does is run `npm start` or `npm run demo`
 * exactly as the README says. A key that works only when you remember a flag is a key that does not
 * work, and the failure is silent: the run completes, every verdict comes back `simulated: true`,
 * and it looks like the project simply has no Nebius integration.
 *
 * So this is called once at the top of anything that might need credentials.
 *
 *   - A variable already set in the real environment always wins. `.env` is a fallback for
 *     convenience, never an override, so `NEBIUS_API_KEY=... npm run demo` behaves as expected.
 *   - A missing file is not an error. Running without credentials is a supported mode here; the
 *     offline judge takes over and everything it produces is labelled `simulated`.
 *   - Nothing is echoed. This file never logs a value, because the values are secrets and the
 *     transcripts of these runs get pasted into issues and submissions.
 */

const fs = require('node:fs');
const path = require('node:path');

/** `export FOO=bar`, `FOO = bar`, quoted values, and `#` comments — the shapes people actually write. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    let value = m[2];
    // Strip one matched pair of surrounding quotes, and only a matched pair: a value that genuinely
    // starts with a quote character is not the same as a quoted value.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

let loaded = false;

/**
 * @param {string} [file]  defaults to `.env` beside this file
 * @returns {string[]} the names — never the values — of the variables this call set
 */
function loadEnv(file = path.join(__dirname, '.env')) {
  if (loaded) return [];
  loaded = true;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no file is a supported state, not a failure
  }

  const set = [];
  for (const [key, value] of Object.entries(parse(text))) {
    if (process.env[key] !== undefined) continue; // the real environment always wins
    process.env[key] = value;
    set.push(key);
  }
  return set;
}

module.exports = { loadEnv, parse };
