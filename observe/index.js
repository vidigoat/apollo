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

const { transcript } = require('../transcript/schema');

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
async function observePackage({ adapter, branch, pkg, version, strategy = 'fsdiff' }) {
  const steps = commandsFor({ pkg, version, strategy });
  const raw = { net: [], dns: [], fs: [], env: [], proc: [] };
  const timing = {};
  const result = {};

  for (const step of steps) {
    const started = Date.now();
    const out = await adapter.run(branch, step.cmd, { pkg, version, strategy, step: step.label });

    if (step.label === 'install') {
      timing.installMs = Date.now() - started;
      result.installExit = out.code;
    }
    if (step.label === 'import') {
      timing.importMs = Date.now() - started;
      result.importExit = out.code;
      result.threw = out.code !== 0;
    }

    // An adapter that can observe returns structured behaviour alongside the exit code.
    if (out.observed) {
      ['net', 'dns', 'fs', 'env', 'proc'].forEach((field) => {
        if (out.observed[field]) raw[field].push(...out.observed[field]);
      });
    }
  }

  return transcript({ pkg, version, strategy, raw, timing, result });
}

/** The best strategy this adapter admits to supporting. */
function bestStrategy(adapter) {
  const supported = adapter.supports || ['fsdiff'];
  return ['ebpf', 'proxy', 'fsdiff'].find((s) => supported.includes(s)) || 'fsdiff';
}

module.exports = { observePackage, commandsFor, bestStrategy };
