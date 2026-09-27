/**
 * Run a suspected package inside a locked-down container, and read back what it did.
 *
 * The interrogation probe (observe/probe.js) blocks egress in-process. That is enough to watch a
 * benign package and plenty for the synthetic samples. It is NOT enough to run REAL malware on
 * someone's machine: a real sample can write files, spawn processes, try to persist. So a real
 * sample runs here, in a container that gives it nothing to reach:
 *
 *   --network none         no network at all, at the kernel — belt to the probe's braces
 *   --read-only            the root filesystem cannot be written
 *   --tmpfs /run/work      one small writable place, in memory, gone when the container is
 *   -v <sample>:/run/sample:ro   the ONLY host path it can see, and it cannot write to it
 *   --cap-drop ALL         no Linux capabilities
 *   --security-opt no-new-privileges
 *   --pids-limit / --memory / --cpus   it cannot fork-bomb, balloon, or peg the machine
 *   -u node                not root, even inside
 *   --rm                   the container is destroyed after
 *
 * Even so: running real third-party malware is a deliberate act, and a throwaway VM is safer than a
 * personal machine. `scripts/malware-eval.js` will not run real samples without an explicit flag and
 * will say this first. Synthetic samples (proof/corpus) carry no such risk and prove the harness.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMAGE = process.env.STAKEOUT_PROOF_IMAGE || 'stakeout-proof:node22';
// The real probe, mounted into the container so there is never a second copy to keep in sync.
const PROBE = path.join(__dirname, '..', 'observe', 'probe.js');

/** Is a container runtime actually here? The eval says so plainly rather than failing mid-run. */
function dockerAvailable() {
  try { require('node:child_process').execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 }); return true; }
  catch { return false; }
}

/**
 * Run one package directory under one provocation, contained at the kernel AND in-process.
 *
 * @param {object} o
 * @param {string} o.dir            a directory whose index.js (or main) is `require`d
 * @param {object} o.provocation    { env, files } — decoy environment (interrogate/provocations.js)
 * @param {string} o.canary         the decoy marker, so the probe can catch it on the wire
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{observed: object|null, timedOut: boolean, code: number}>}
 */
// Docker Desktop on macOS shares /Users but not /var/folders (os.tmpdir()), so the work directory
// the container bind-mounts lives under the repo, where the mount actually appears.
const WORK_BASE = process.env.STAKEOUT_PROOF_WORK || path.join(__dirname, '.work');

function runContained({ dir, provocation = { env: {}, files: {} }, canary = '', timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    fs.mkdirSync(WORK_BASE, { recursive: true });
    const work = fs.mkdtempSync(path.join(WORK_BASE, 'run-'));
    // The runner and any planted decoy files are written into the sample dir's sibling work area,
    // mounted writable via tmpfs inside the container. The sample itself is mounted read-only.
    const home = path.join(work, 'home');
    for (const [rel, content] of Object.entries(provocation.files || {})) {
      const full = path.join(home, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const runner = `
      const p = require('/run/probe.js').install();
      try { require('/run/sample'); } catch (e) {}
      setTimeout(() => { require('fs').writeFileSync('/run/work/report.json', JSON.stringify(p.seen)); process.exit(0); }, 500);
    `;
    fs.writeFileSync(path.join(work, 'runner.js'), runner);

    const env = { STAKEOUT_CONTAINED: '1', STAKEOUT_CANARY: canary, HOME: '/run/work/home', ...(provocation.env || {}) };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '512m',
      '--cpus', '1',
      '-v', `${PROBE}:/run/probe.js:ro`,
      '-v', `${dir}:/run/sample:ro`,
      '-v', `${work}:/run/work`,
      ...envArgs,
      IMAGE,
      '/run/work/runner.js',
    ];
    execFile('docker', args, { timeout: timeoutMs + 10000, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      let observed = null;
      try { observed = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8')); } catch { observed = null; }
      fs.rmSync(work, { recursive: true, force: true });
      resolve({ observed, timedOut: Boolean(err && err.killed), code: err ? (err.code ?? 1) : 0 });
    });
  });
}

module.exports = { runContained, dockerAvailable, IMAGE };
