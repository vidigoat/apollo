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

const MARKER = '__APOLLO__';

function install() {
  const seen = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
  const push = (k, v) => { if (seen[k].length < 500) seen[k].push(v); };

  /*
   * Contained mode: record what the package reaches for, and let NONE of it out.
   *
   * Set by APOLLO_CONTAINED. Normal observation forwards the real call — a popular, benign
   * package doing legitimate network things is fine, and blocking it would hide behaviour. But
   * SUSPECTED code (a lookalike) and the interrogation agent's probes must never actually egress:
   * Nebius's AUP forbids running malicious code and any network egress/attack, and the whole point
   * of interrogation is to see a stealer TRY to send a planted token, not to help it. So here the
   * attempt is recorded and then failed, without the real socket, DNS or TLS ever being touched.
   * `contained` also travels in the report, so a transcript can never be mistaken for one where the
   * package was actually allowed to reach the network.
   */
  const CONTAINED = Boolean(process.env.APOLLO_CONTAINED);
  seen.contained = CONTAINED;
  const HARNESS_ENV = new Set(['APOLLO_CONTAINED', 'APOLLO_CANARY', 'APOLLO_CLOCK_OFFSET_DAYS', 'APOLLO_INSTALL_DIR', 'APOLLO_NPM_ROOT']);

  /* ── clock ───────────────────────────────────────────────────────────
   * A payload that waits for a date before it acts sees nothing wrong in a sandbox opened today. So
   * APOLLO_CLOCK_OFFSET_DAYS moves the clock the PACKAGE sees forward, without touching the real
   * one: Date.now() and `new Date()` with no argument return the future, and a read of the shifted
   * clock is recorded, so a dormancy check is itself a signal. Timers are left alone — they run on
   * the real clock, so the probe still writes its report on time.
   */
  const offsetDays = Number(process.env.APOLLO_CLOCK_OFFSET_DAYS) || 0;
  if (offsetDays) {
    const shiftMs = offsetDays * 86400000;
    const RealDate = Date;
    const realNow = RealDate.now;
    const shifted = class extends RealDate {
      constructor(...a) { if (a.length === 0) { super(realNow() + shiftMs); push('proc', 'read shifted clock'); } else { super(...a); } }
      static now() { push('proc', 'read shifted clock'); return realNow() + shiftMs; }
    };
    // eslint-disable-next-line no-global-assign
    Date = shifted;
  }

  /* ── environment ─────────────────────────────────────────────────── */
  // A read is the signal. Which variable was read matters; the value must never leave this process.
  /*
   * Only reads the package's own code makes.
   *
   * Every read was counted, and Node reads the environment on the package's behalf while loading it:
   * `NODE_V8_COVERAGE` in maybeCacheSourceMap whenever a file ships a source map, and
   * `WATCH_REPORT_DEPENDENCIES` in the ESM loader, and FORCE_COLOR while initialising its own colour
   * support. Across the index that credited 3,176 package versions with reading NODE_V8_COVERAGE —
   * babel helpers "reading coverage settings" — which is Node's behaviour, not theirs. So the frame
   * that made the read decides: a caller inside `node:` is the runtime, and is not the package.
   */
  const fromRuntime = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 4;
    const stack = String(new Error().stack || '');
    Error.stackTraceLimit = limit;
    // [0] "Error", [1] this function, [2] the trap, [3] whoever touched process.env.
    const caller = stack.split('\n')[3] || '';
    return /\(node:|at node:/.test(caller);
  };
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(target, prop) {
      // Never our own instrumentation: these exact vars are the harness talking to itself. Only
      // these, not every APOLLO_* name, so a package's own read of such a var is still its read.
      if (typeof prop === 'string' && !HARNESS_ENV.has(prop) && !fromRuntime()) push('env', prop);
      return target[prop];
    },
  });

  /* ── network ─────────────────────────────────────────────────────── */
  const net = require('node:net');
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.connect(port, host) and every plain http request arrive here as Node's normalised
    // [options, callback] array, not as options — read as an object it had no host and no port.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = first && typeof first === 'object' ? first : { port: first, host: args[1] };
    push('net', { host: String(o.host || o.path || 'localhost'), port: Number(o.port) || null, proto: 'tcp' });
    if (CONTAINED) {
      // Fail like a refused connection, without the real socket ever leaving the box. The last
      // callback argument, if any, is the caller's 'connect' listener — never called, so nothing
      // downstream believes it connected.
      process.nextTick(() => { try { this.destroy(Object.assign(new Error('apollo: egress blocked (contained)'), { code: 'ECONNREFUSED' })); } catch { /* already gone */ } });
      return this;
    }
    return realConnect.apply(this, args);
  };

  /*
   * Only when contained: watch what is WRITTEN to a socket, for the decoy's marker. The connect
   * patch shows it tried to reach out; this shows it put the planted secret on the wire — a stealer
   * caught with the token in its hand, and stopped, because contained means the bytes never left.
   * Off outside containment: reading every package's socket writes in the normal watch is neither
   * needed nor wanted.
   */
  const CANARY = process.env.APOLLO_CANARY || null;
  if (CONTAINED && CANARY) {
    // The request body is handed to ClientRequest.write / .end, which is BEFORE the socket — so it
    // is seen even though containment fails the socket a tick later and the bytes never leave. This
    // is the moment a stealer is caught with the token in its hand. http, https, and a raw socket
    // write (some code builds the request by hand) are all covered.
    const scan = (chunk) => {
      try {
        const b = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : '';
        if (b && b.includes(CANARY)) push('net', { exfil: true, marker: 'canary' });
      } catch { /* never let instrumentation throw into the package */ }
    };
    for (const modName of ['node:http', 'node:https']) {
      const mod = require(modName);
      const CR = mod.ClientRequest && mod.ClientRequest.prototype;
      if (!CR) continue;
      for (const fn of ['write', 'end']) {
        const real = CR[fn];
        if (typeof real !== 'function') continue;
        CR[fn] = function (chunk, ...rest) { scan(chunk); return real.apply(this, [chunk, ...rest]); };
      }
    }
    const realWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (chunk, ...rest) { scan(chunk); return realWrite.apply(this, [chunk, ...rest]); };
  }

  const tls = require('node:tls');
  const realTls = tls.connect;
  tls.connect = function (...args) {
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    push('net', { host: String(o.host || o.servername || 'unknown'), port: Number(o.port) || 443, proto: 'tls' });
    if (CONTAINED) {
      // A socket that never connects: record, then error. A stub rather than a real TLSSocket,
      // because a real one would open the underlying TCP connection this is here to prevent.
      const s = new net.Socket();
      process.nextTick(() => { try { s.destroy(Object.assign(new Error('apollo: egress blocked (contained)'), { code: 'ECONNREFUSED' })); } catch { /* already gone */ } });
      const cb = args.find((a) => typeof a === 'function');
      return s;
    }
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
        if (CONTAINED) {
          // No resolution leaves the box. A callback caller gets ENOTFOUND; a promise caller a
          // rejection — the same shape a real failed lookup has, so the package handles it normally.
          const err = Object.assign(new Error(`apollo: DNS blocked (contained): ${String(name)}`), { code: 'ENOTFOUND' });
          const cb = rest[rest.length - 1];
          if (typeof cb === 'function') { process.nextTick(() => cb(err)); return undefined; }
          return Promise.reject(err);
        }
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
    // The same rule as environment reads: Node decodes on a package's behalf too — loading node:http, whose bundled HTTP parser it decodes,
    // did for agent-base@9.0.0, which contains no base64 at all — and that is Node, not the package.
    if (enc === 'base64' && typeof value === 'string' && value.length > 128 && !fromRuntime()) {
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
function runnerSource(pkg, outPath, probePath = __filename, installDir = null) {
  // `probePath` is where the probe lives on the machine that will run this — this file's own path
  // locally, and wherever it was uploaded inside a sandbox. `installDir` is where the install step's
  // processes left their reports (see INSTALL_DIR below); read before the probe is installed, so the
  // reading is not itself observed.
  return `
const fs = require('node:fs');
const path = require('node:path');
const INSTALL_DIR = ${JSON.stringify(installDir)};
let installSeen = null;
if (INSTALL_DIR) {
  try {
    const parts = fs.readdirSync(INSTALL_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
    // No report at all means the phase was not watched — npm itself always reports — so it stays
    // null, never an empty install that reads as "ran nothing".
    if (!parts.some((r) => r.role === 'npm')) throw new Error('not watched');
    installSeen = { net: [], dns: [], fs: [], env: [], proc: [], exec: [], processes: parts.length };
    for (const r of parts) for (const k of ['net', 'dns', 'fs', 'env', 'proc', 'exec']) {
      if (Array.isArray(r.seen && r.seen[k])) installSeen[k].push(...r.seen[k].slice(0, 500));
    }
  } catch { installSeen = null; }
}
const { install } = require(${JSON.stringify(probePath)});
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
  try { fs.writeFileSync(OUT, JSON.stringify({ ...probe.seen, threw, ...(installSeen ? { install: installSeen } : {}) })); } catch {}
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
  return parseReport(raw);
}

/**
 * The same check, on bytes rather than a path.
 *
 * In a real sandbox the report never touches this machine's disk: it is written inside the
 * microVM and read back out of the image the run produced. Splitting the parse from the read means
 * both adapters apply exactly one definition of what a trustworthy report looks like.
 */
function parseReport(raw) {
  if (raw == null) return null;
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
  // The install phase, when it was watched: the same six channels, the same rule. A malformed one
  // is dropped rather than trusted — the import observation still stands on its own.
  const i = parsed.install;
  if (i && typeof i === 'object' && !Array.isArray(i) && ['net', 'dns', 'fs', 'env', 'proc', 'exec'].every((k) => Array.isArray(i[k]))) {
    out.install = Object.fromEntries(['net', 'dns', 'fs', 'env', 'proc', 'exec'].map((k) => [k, i[k]]));
  }
  // Whether egress was blocked is a property of the observation, not decoration: a transcript that
  // does not say whether the package was allowed to reach the network is one nobody can weigh. Kept
  // only as a real boolean, like the channels — never coerced.
  if (typeof parsed.contained === 'boolean') out.contained = parsed.contained;
  return out;
}

/*
 * ── The install phase ──────────────────────────────────────────────────────
 *
 * The runner above watches the import. An install script — `preinstall`, `install`,
 * `postinstall` — runs before that, and npm 10 and 11 run it by default. So the install step runs
 * with NODE_OPTIONS=--require <this file> and APOLLO_INSTALL_DIR set, and every Node process it
 * starts loads this block:
 *
 *   - npm itself records only which processes it starts. That is the list of lifecycle scripts that
 *     ran, command line and all — and it leaves npm's own registry traffic, config reads and cache
 *     writes out, which are npm's behaviour, not the package's.
 *   - any other Node process — an install script, or something one started — is watched whole.
 *
 * Each writes its own report when it exits; the runner gathers them before the import. A script
 * written in shell rather than Node is seen as the command npm started, not from inside.
 */
const INSTALL_DIR = process.env.APOLLO_INSTALL_DIR;
if (INSTALL_DIR && !global.__apolloInstallPhase) {
  global.__apolloInstallPhase = true;
  /*
   * npm is recognised by where it really is, not by what it is called. By name alone, a postinstall
   * running `node npm-cli.js` — or anything under a folder called node_modules/npm — was taken for
   * npm and watched only for what it started, which hid its network and environment reads (a test
   * does exactly that). APOLLO_NPM_ROOT is the npm the install was started with, set by the
   * adapter; a process counts as npm only if its script's real path is inside it.
   */
  const npmRoot = process.env.APOLLO_NPM_ROOT;
  let isNpm = false;
  if (npmRoot) {
    try {
      const fsp = require('node:fs');
      const real = fsp.realpathSync(String(process.argv[1] || ''));
      const root = fsp.realpathSync(npmRoot);
      isNpm = real.startsWith(`${root}/`) || real.startsWith(`${root}\\`);
    } catch { isNpm = false; }
  }
  // Captured before install() patches fs, so writing the report is not recorded as the package's write.
  const fsReal = require('node:fs');
  const write = fsReal.writeFileSync;
  let seen;
  if (isNpm) {
    seen = { net: [], dns: [], fs: [], env: [], proc: [], exec: [] };
    const cp = require('node:child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      const real = cp[fn];
      if (typeof real !== 'function') continue;
      cp[fn] = function (cmd, ...rest) {
        const a = Array.isArray(rest[0]) ? rest[0] : [];
        if (seen.proc.length < 500) seen.proc.push({ argv: [String(cmd), ...a.map(String)] });
        return real.call(cp, cmd, ...rest);
      };
    }
  } else {
    seen = install().seen;
  }
  process.on('exit', () => {
    try {
      const body = JSON.stringify({ role: isNpm ? 'npm' : 'script', seen });
      fsReal.mkdirSync(INSTALL_DIR, { recursive: true });
      write(`${INSTALL_DIR}/${process.pid}-${Date.now()}.json`, body);
    } catch { /* a report that cannot be written is a phase not seen, and the runner says so */ }
  });
}

module.exports = { install, runnerSource, readReport, parseReport, MARKER };
