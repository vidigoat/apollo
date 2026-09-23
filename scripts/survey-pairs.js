/**
 * The survey's pairs, as data and nothing else.
 *
 * The hosted server reads this list (`/api/tree` shows it), and it used to import it from
 * scripts/survey.js — which loads the local adapter, the cache and the environment as a side
 * effect. On the deployed bundle that side effect left the list undefined, and `/api/tree` answered
 * 500 on the page every judge opens first. A list of pairs needs no machinery to be read.
 */
/**
 * Real packages, real consecutive-ish versions, chosen for ubiquity rather than for interest.
 * Between them these sit under a very large share of the JavaScript ecosystem.
 */
const PAIRS = [
  ['left-pad', '1.2.0', '1.3.0'],
  ['ms', '2.1.2', '2.1.3'],
  ['picocolors', '1.0.0', '1.1.1'],
  ['debug', '4.3.4', '4.4.0'],
  ['chalk', '5.3.0', '5.4.1'],
  ['semver', '7.5.4', '7.6.3'],
  ['uuid', '9.0.0', '9.0.1'],
  ['dotenv', '16.3.1', '16.4.7'],
  ['nanoid', '4.0.2', '5.0.9'],
  ['yallist', '4.0.0', '5.0.0'],
  ['lru-cache', '10.0.0', '10.4.3'],
  ['mime-types', '2.1.34', '2.1.35'],
  ['escape-string-regexp', '4.0.0', '5.0.0'],
  ['strip-ansi', '7.0.1', '7.1.0'],
  ['ansi-regex', '6.0.1', '6.1.0'],
  ['is-glob', '4.0.1', '4.0.3'],
  ['path-to-regexp', '6.2.1', '6.3.0'],
  ['tslib', '2.6.0', '2.8.1'],
  ['ejs', '3.1.9', '3.1.10'],
  ['minimatch', '9.0.0', '9.0.5'],
  // A second twenty, added to make the baseline harder to dismiss. Same rule: chosen for being
  // depended upon, never for being interesting.
  ['clsx', '1.2.1', '2.1.1'],
  ['yocto-queue', '1.0.0', '1.1.1'],
  ['eventemitter3', '4.0.7', '5.0.1'],
  ['object-assign', '4.1.0', '4.1.1'],
  ['safe-buffer', '5.1.2', '5.2.1'],
  ['side-channel', '1.0.4', '1.0.6'],
  ['has-flag', '3.0.0', '4.0.0'],
  ['color-name', '1.1.3', '1.1.4'],
  ['wrappy', '1.0.1', '1.0.2'],
  ['inherits', '2.0.3', '2.0.4'],
  ['isexe', '2.0.0', '3.1.1'],
  ['balanced-match', '1.0.0', '1.0.2'],
  ['brace-expansion', '2.0.0', '2.0.1'],
  ['emoji-regex', '9.2.0', '9.2.2'],
  ['is-number', '6.0.0', '7.0.0'],
  ['queue-microtask', '1.2.2', '1.2.3'],
  ['reusify', '1.0.2', '1.0.4'],
  ['run-parallel', '1.1.10', '1.2.0'],
  ['to-regex-range', '5.0.0', '5.0.1'],
  ['fastq', '1.13.0', '1.17.1'],

  /*
   * Second batch, added later and derived rather than recalled.
   *
   * Every pair below came out of `node scripts/pairs.js --suggest <names>`, which reads the registry
   * and takes the two most recent adjacent-in-publication-time releases that go forward in semver and
   * do not cross more than one major. None of these version numbers was typed from memory, which is
   * the point: the first batch was, and one of them — `is-number 7.0.0 → 7.0.0` — was a version
   * compared against itself, contributing a guaranteed "no change" to the baseline for months.
   *
   * These are transitive dependencies rather than things people install on purpose. That is
   * deliberate. A lockfile is mostly packages nobody chose, and a baseline drawn only from packages
   * people chose would describe a registry nobody actually installs.
   */
  ['cookie', '2.0.0', '2.0.1'],
  ['qs', '6.15.3', '6.16.0'],
  ['bytes', '3.1.1', '3.1.2'],
  ['statuses', '2.0.1', '2.0.2'],
  ['toidentifier', '1.0.0', '1.0.1'],
  ['content-type', '3.0.0', '3.1.0'],
  ['on-finished', '2.4.0', '2.4.1'],
  ['ee-first', '1.1.0', '1.1.1'],
  ['destroy', '1.1.1', '1.2.0'],
  ['escape-html', '1.0.2', '1.0.3'],
  ['parseurl', '1.3.2', '1.3.3'],
  ['encodeurl', '1.0.2', '2.0.0'],
  ['setprototypeof', '1.1.1', '1.2.0'],
  ['vary', '1.1.1', '1.1.2'],
  ['supports-color', '10.2.2', '11.0.0'],
  ['color-convert', '3.1.2', '3.1.3'],
  ['ansi-styles', '6.2.3', '7.0.0'],
  ['string-width', '8.2.1', '8.2.2'],
  ['wrap-ansi', '10.0.0', '10.0.1'],
  ['cliui', '9.0.0', '9.0.1'],
  ['get-caller-file', '2.0.4', '2.0.5'],
  ['require-directory', '2.1.0', '2.1.1'],
  ['camelcase', '8.0.0', '9.0.0'],
  ['p-limit', '7.3.1', '7.3.2'],
  ['make-dir', '5.0.0', '5.1.0'],
  ['graceful-fs', '4.2.10', '4.2.11'],
  ['glob-parent', '6.0.1', '6.0.2'],
  ['anymatch', '3.1.2', '3.1.3'],
  ['binary-extensions', '3.1.0', '3.2.0'],
  ['picomatch', '4.0.6', '4.0.7'],
  ['braces', '3.0.2', '3.0.3'],
  ['fill-range', '7.0.1', '7.1.1'],
  ['undici-types', '8.10.1', '8.10.2'],
  ['combined-stream', '1.0.7', '1.0.8'],
  ['asynckit', '0.4.0', '0.5.0'],
  ['proxy-from-env', '2.0.0', '2.1.0'],
  ['mime', '4.0.7', '4.1.0'],
  ['argparse', '3.0.1', '3.0.2'],
  ['esprima', '4.0.0', '4.0.1'],
  ['js-yaml', '5.4.0', '5.4.1'],
  ['resolve-from', '4.0.0', '5.0.0'],
  ['callsites', '4.1.0', '4.2.0'],
];

module.exports = { PAIRS };
