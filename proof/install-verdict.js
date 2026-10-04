/**
 * What a package's own install scripts did, read against rules — for a package with no "before".
 *
 * Stakeout's ordinary claim is a DIFF: this release does something the last one did not. Most real
 * malware on npm offers no such comparison — a typosquat is version 1.0.0 of a name that never
 * existed — so there is only what the install did, taken by itself. Rules for that have to be
 * narrower than the differ's, because "it ran a shell" is true of every lifecycle script there is.
 *
 * Three findings count as STRONG, each something an honest install has little reason to do:
 *
 *   credentials   it read a publish or cloud credential out of the environment
 *   downloader    it ran a network tool, or piped something into a shell
 *   decoyStolen   a planted decoy value was put on the wire (the interrogation's catch)
 *
 * One is WEAK and is reported apart, never folded in: it reached for the network at install. Real
 * packages do that to fetch a prebuilt binary, and on the real registry it is uncommon rather than
 * suspicious — docs/install-phase.json has the measured base rates for all of these, which is the
 * only honest thing to read a detection number against.
 */

const { readsCredential } = require('../differ/diff');

// A network tool by name, a pipe into a shell, or a decode-and-run. Not "sh": npm runs every
// lifecycle script through one.
const DOWNLOADER = /\b(curl|wget|ncat|netcat|powershell|pwsh|certutil|bitsadmin|scp|ftp)\b|\bnc\s+-|\|\s*(ba|z|da|k)?sh\b|\bbase64\s+(-d|--decode)\b|\beval\s*\(?\s*["'`$]/i;
const LOCAL = /^(localhost|127\.|::1|0\.0\.0\.0|\/|\.)/;

const text = (p) => (p && typeof p === 'object' && Array.isArray(p.argv) ? p.argv.join(' ') : String(p ?? ''));

/**
 * @param {object|null} observed   a contained run's report (proof/harden.js with install: true)
 * @param {object} [o]
 * @param {boolean} [o.decoyStolen]  from interrogate.stolenDecoy — the canary was seen on the wire
 */
function installVerdict(observed, { decoyStolen = false } = {}) {
  const i = observed && typeof observed === 'object' ? observed.install : null;
  if (!i || typeof i !== 'object') {
    // Not watched is not clean. The caller counts these apart.
    return { watched: false, ranScript: false, scripts: [], credentials: [], downloader: [], network: [], decoyStolen: false, strong: false, weak: false, reasons: ['the install phase was not observed'] };
  }
  const arr = (k) => (Array.isArray(i[k]) ? i[k] : []);
  const scripts = arr('scripts').map((s) => s && s.name).filter(Boolean);
  const credentials = [...new Set(arr('env').filter((e) => typeof e === 'string' && readsCredential(e)))];
  const downloader = [...new Set(arr('proc').map(text).filter((t) => DOWNLOADER.test(t)).map((t) => t.slice(0, 200)))];
  const network = [...new Set([...arr('net').map((n) => (n && typeof n === 'object' ? n.host : n)), ...arr('dns')]
    .filter((h) => typeof h === 'string' && h && !LOCAL.test(h)))];

  const reasons = [];
  if (decoyStolen) reasons.push('put a planted decoy credential on the wire');
  if (credentials.length) reasons.push(`read ${credentials.length} credential${credentials.length === 1 ? '' : 's'} at install (${credentials.slice(0, 4).join(', ')})`);
  if (downloader.length) reasons.push('ran a network tool or piped into a shell at install');
  const strong = reasons.length > 0;
  if (network.length) reasons.push(`reached for ${network.length} host${network.length === 1 ? '' : 's'} at install (${network.slice(0, 3).join(', ')})`);

  return { watched: true, ranScript: scripts.length > 0, scripts, credentials, downloader, network, decoyStolen, strong, weak: !strong && network.length > 0, reasons };
}

module.exports = { installVerdict, DOWNLOADER };
