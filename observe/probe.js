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
  const seen = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
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

  /* ── code built at runtime ───────────────────────────────────────────
   * The one thing this strategy sees that a kernel tracer cannot.
   *
   * 2026's attacks do not ship the payload; they ship a decoder. A base64 blob turning into a
   * function is not a syscall — it is a string becoming behaviour inside one process, and eBPF
   * watches the process rather than the thought. By the time anything reaches the kernel the
   * interesting part already happened.
   *
   * Recorded as a short excerpt, never the whole payload: a megabyte of obfuscated source is
   * volume, not evidence, and the differ compares transcripts rather than reads them.
   */
  const note = (how, sample) => push('exec', { how, sample: String(sample ?? '').slice(0, 160) });

  const RealFunction = global.Function;
  function PatchedFunction(...args) {
    // new Function('a','b','return a+b') — the body is the last argument.
    note('Function', args[args.length - 1]);
    return RealFunction.apply(this, args);
  }
  PatchedFunction.prototype = RealFunction.prototype;
  global.Function = PatchedFunction;

  const vm = require('node:vm');
  for (const fn of ['runInNewContext', 'runInThisContext', 'runInContext', 'compileFunction']) {
    const real = vm[fn];
    if (typeof real !== 'function') continue;
    vm[fn] = function (code, ...rest) {
      note(`vm.${fn}`, code);
      return real.call(vm, code, ...rest);
    };
  }
  const RealScript = vm.Script;
  if (typeof RealScript === 'function') {
    vm.Script = function (code, ...rest) {
      note('vm.Script', code);
      return new RealScript(code, ...rest);
    };
    vm.Script.prototype = RealScript.prototype;
  }

  // Decoding is not itself suspicious — it is what decoding FEEDS that matters, and the entries
  // above catch that. Recorded anyway, because "decoded something, then built a function" is a
  // shape, and a shape is what the differ is good at.
  const RealFrom = Buffer.from;
  Buffer.from = function (value, enc, ...rest) {
    if (enc === 'base64' && typeof value === 'string' && value.length > 128) {
      note('base64-decode', `${value.length} chars`);
    }
    return RealFrom.call(Buffer, value, enc, ...rest);
  };

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

/**
 * The script that runs inside the twin. Written to disk, then executed.
 *
 * The report goes to a file rather than stdout. Two reasons, and the second is the real one:
 * packages print, sometimes megabytes of it, and — more importantly — anything written to stdout
 * can be *forged*. A package that registers a `process.on('exit')` handler runs after we do, and
 * could print a clean report of its own for us to find.
 *
 * A file does not fix that completely; nothing in-process can, because the package and the probe
 * share a heap. It removes the trivial version. The honest containment story is still a microVM,
 * which is what adapters/contree.js is for.
 */
function runnerSource(pkg, outPath) {
  return `
const fs = require('node:fs');
const { install } = require(${JSON.stringify(__filename)});
const OUT = ${JSON.stringify(outPath)};
const probe = install();
let threw = null;
try {
  require(${JSON.stringify(pkg)});
} catch (e) {
  threw = e && e.message ? String(e.message).slice(0, 300) : 'threw';
}
// Give anything the import kicked off a moment to actually reach the network.
setTimeout(() => {
  try { fs.writeFileSync(OUT, JSON.stringify({ ...probe.seen, threw })); } catch {}
  process.exit(0);
}, 300);
`;
}

/**
 * Read the observation back.
 *
 * Returns null when there is no report — the process crashed, timed out, or called `process.exit`
 * before we wrote. Null means *we did not see*, and must never be turned into an empty transcript,
 * which would mean *it did nothing*. See docs/decisions/005.
 */
function readReport(outPath) {
  const fs = require('node:fs');
  let raw;
  try {
    raw = fs.readFileSync(outPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // a package overwrote it with something else
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // Take only the channels we know, in the shape we expect. A forged report with extra keys, or
  // with a string where an array belongs, is not quietly trusted.
  const out = {};
  for (const k of ['net', 'dns', 'fs', 'env', 'proc', 'exec']) {
    if (!Array.isArray(parsed[k])) return null;
    out[k] = parsed[k];
  }
  return out;
}

module.exports = { install, runnerSource, readReport, MARKER };
