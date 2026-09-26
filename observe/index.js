/**
 * Watching one package in one disposable machine.
 *
 * Three strategies, in descending order of what they can see. The engine asks for the best one the
 * environment will actually support and the transcript records which one ran, because "no network
 * activity" from a run that could not watch the network is a lie.
 *
 *   ebpf     sees syscalls and sockets. Each sandbox is its own microVM, so the tenant is root in
 *            their own kernel and this is available in a way it is not inside a shared container.
 *   proxy    all egress through an allowlist proxy: every destination recorded, nothing else.
 *   fsdiff   the cheapest, and free: we already checkpoint the filesystem, so comparing the image
 *            before and after costs nothing extra. Sees writes and nothing else.
 *
 * The commands below are what actually runs inside the twin. Install, then import — because since
 * npm 12 disabled install scripts by default, the interesting moment moved to `require`.
 */

const { transcript, STRENGTH } = require('../transcript/schema');
const { runnerSource } = require('./probe');

/** What we do inside the twin, in order. */
function commandsFor({ pkg, version, strategy }) {
  const install = `npm install ${pkg}@${version} --ignore-scripts=false --no-audit --no-fund`;
  // Importing is the point: this is where 2026's attacks detonate.
  const importIt = `node -e "require('${pkg}')"`;

  switch (strategy) {
    case 'ebpf':
      return [
        { label: 'trace-on', cmd: 'bpftrace -o /tmp/trace.log -e \'tracepoint:syscalls:sys_enter_connect,tracepoint:syscalls:sys_enter_openat,tracepoint:syscalls:sys_enter_execve { printf("%s %s\\n", probe, str(args->filename)); }\' &' },
        { label: 'install', cmd: install },
        { label: 'import', cmd: importIt },
        { label: 'collect', cmd: 'cat /tmp/trace.log' },
      ];
    case 'proxy':
      return [
        { label: 'proxy-on', cmd: 'HTTP_PROXY=http://127.0.0.1:8118 HTTPS_PROXY=http://127.0.0.1:8118' },
        { label: 'install', cmd: install },
        { label: 'import', cmd: importIt },
        { label: 'collect', cmd: 'cat /var/log/egress.log' },
      ];
    case 'nodert':
      // No infrastructure at all: the probe is loaded before the package and reports on stdout.
      // The adapter writes the runner; here we only say what the steps are.
      return [
        { label: 'install', cmd: install },
        { label: 'import', cmd: 'node __stakeout_runner.js' },
      ];
    case 'fsdiff':
    default:
      return [
        { label: 'install', cmd: install },
        { label: 'import', cmd: importIt },
        // The filesystem delta comes from the checkpoint itself — nothing to collect.
      ];
  }
}

/**
 * Run one package at one version in one branch, and come back with a transcript.
 *
 * The adapter decides what actually happens; this decides what we ask it to do and how the result
 * is written down. Nothing here interprets behaviour — that is the differ's job, and then a model's.
 */
async function observePackage({ adapter, branch, pkg, version, strategy = 'fsdiff', provocation = null }) {
  const steps = commandsFor({ pkg, version, strategy });
  const raw = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
  const timing = {};
  const result = {};
  let reported = false;

  for (const step of steps) {
    const started = Date.now();
    const out = await adapter.run(branch, step.cmd, { pkg, version, strategy, step: step.label, provocation });

    if (step.label === 'install') {
      timing.installMs = Date.now() - started;
      result.installExit = out.code;
      // npm's own word for why, when it gives one — EBADPLATFORM, ETARGET, E404 — so a refusal says
      // "built for darwin" rather than only "exited 1".
      if (out.code) {
        const m = /npm (?:ERR!|error) code (\w+)/.exec(`${out.stderr || ''}\n${out.stdout || ''}`);
        const gyp = /gyp ERR! (?:find Python|stack Error: `?make`? failed|build error)/.test(`${out.stderr || ''}`);
        // A lifecycle script that exits non-zero shows up as `code 1` — a number, not a reason.
        result.installError = gyp ? 'native build failed'
          : m && !/^\d+$/.test(m[1]) ? m[1]
            : m ? 'its install script failed' : null;
      }
    }
    if (step.label === 'import') {
      timing.importMs = Date.now() - started;
      result.importExit = out.code;
      result.threw = out.code !== 0;
    }

    // An adapter that can observe returns structured behaviour alongside the exit code.
    if (out.observed) {
      reported = true;
      // The install phase travels separately, so the import channels mean what they always meant.
      if (out.observed.install) raw.install = out.observed.install;
      ['net', 'dns', 'fs', 'env', 'proc', 'exec'].forEach((field) => {
        if (out.observed[field]) raw[field].push(...out.observed[field]);
      });
    }
  }

  // Under nodert the probe's report IS the observation. No report — a crash, a timeout, a package
  // that never installed — means nothing was seen, and empty channels must not say otherwise.
  if (strategy === 'nodert') result.reported = reported;
  return transcript({ pkg, version, strategy, raw, timing, result });
}

/** The best strategy this adapter admits to supporting. */
function bestStrategy(adapter) {
  const supported = adapter.supports || ['fsdiff'];
  return STRENGTH.find((s) => supported.includes(s)) || 'fsdiff';
}

module.exports = { observePackage, commandsFor, bestStrategy };
