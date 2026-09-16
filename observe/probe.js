/**
 * Watching a package from inside the process that imports it.
 *
 * The three strategies in `observe/index.js` all need infrastructure we do not have yet — a guest
 * kernel with BPF, an egress proxy, a filesystem snapshot. This one needs nothing. It patches
 * Node's own APIs before `require()` runs and records what the package reaches for.
 *
 * That makes it the only strategy that works on a laptop today, which is why it exists: a project
 * whose every observation is simulated is a design document.
 *
 * **What it can be defeated by, stated plainly.** It watches Node's API surface, so anything that
 * goes underneath is invisible: a native addon, a WebAssembly module with its own imports, or code
 * that captures a reference to `net.Socket` before this file runs. It is honest instrumentation,
 * not a sandbox — which is exactly why `canSee` for this strategy is narrower than eBPF's, and why
 * the real answer is still a microVM with a kernel we control.
 *
 * Emits one JSON object on the last line of stdout, prefixed so it cannot be confused with
 * anything the package itself printed.
 */

const MARKER = '__STAKEOUT__';

function install() {
  const seen = { net: [], dns: [], fs: [], env: [], proc: [] };
  const push = (k, v) => { if (seen[k].length < 500) seen[k].push(v); };

  /* ── environment ─────────────────────────────────────────────────── */
  // A read is the signal. Which variable was read matters; the value must never leave this process.
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(target, prop) {
      if (typeof prop === 'string') push('env', prop);
      return target[prop];
    },
  });

  /* ── network ─────────────────────────────────────────────────────── */
  const net = require('node:net');
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    push('net', { host: String(o.host || o.path || 'localhost'), port: Number(o.port) || null, proto: 'tcp' });
    return realConnect.apply(this, args);
  };

  const tls = require('node:tls');
  const realTls = tls.connect;
  tls.connect = function (...args) {
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    push('net', { host: String(o.host || o.servername || 'unknown'), port: Number(o.port) || 443, proto: 'tls' });
    return realTls.apply(this, args);
  };

  /* ── dns ─────────────────────────────────────────────────────────── */
  const dns = require('node:dns');
  for (const mod of [dns, dns.promises]) {
    for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      if (typeof mod[fn] !== 'function') continue;
      const real = mod[fn].bind(mod);
      mod[fn] = function (name, ...rest) {
        push('dns', String(name));
        return real(name, ...rest);
      };
    }
  }

  /* ── processes ───────────────────────────────────────────────────── */
  const cp = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const real = cp[fn];
    if (typeof real !== 'function') continue;
    cp[fn] = function (cmd, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      push('proc', { argv: [String(cmd), ...args.map(String)] });
      return real.call(cp, cmd, ...rest);
    };
  }

  /* ── filesystem ──────────────────────────────────────────────────── */
  // Writes only. Reads inside node_modules are what `require` does all day and mean nothing.
  const fs = require('node:fs');
  for (const fn of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'unlink', 'unlinkSync']) {
    const real = fs[fn];
    if (typeof real !== 'function') continue;
    fs[fn] = function (p, ...rest) {
      push('fs', { op: fn.startsWith('unlink') ? 'delete' : 'write', path: String(p) });
      return real.call(fs, p, ...rest);
    };
  }

  return { seen, report: () => `${MARKER}${JSON.stringify(seen)}` };
}

/** The script that runs inside the twin. Written to disk, then executed. */
function runnerSource(pkg) {
  return `
const { install } = require(${JSON.stringify(__filename)});
const probe = install();
let threw = null;
try {
  require(${JSON.stringify(pkg)});
} catch (e) {
  threw = e && e.message ? String(e.message).slice(0, 300) : 'threw';
}
// Give anything the import kicked off a moment to actually reach the network.
setTimeout(() => {
  process.stdout.write('\\n' + probe.report() + '\\n');
  process.exit(0);
}, 300);
`;
}

/** Pull the observation back out of whatever the package also printed. */
function parseReport(stdout) {
  const line = String(stdout).split('\n').reverse().find((l) => l.startsWith(MARKER));
  if (!line) return null; // did not run, or died before reporting — NOT the same as "did nothing"
  try {
    return JSON.parse(line.slice(MARKER.length));
  } catch {
    return null;
  }
}

module.exports = { install, runnerSource, parseReport, MARKER };
