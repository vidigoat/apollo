/**
 * What a package did, written down.
 *
 * A transcript is the observable behaviour of one package in one disposable machine: what it
 * touched, who it called, what it read, what it spawned. It is evidence, so two properties matter
 * more than completeness.
 *
 * **It must be comparable.** Two runs of the same version from the same checkpoint have to produce
 * identical transcripts, or a diff means nothing. Everything that varies between runs and carries
 * no meaning — temp directories, pids, ephemeral ports, timestamps, cache keys — is normalised out.
 * Anything left that differs is real.
 *
 * **It must say what it could not see.** A transcript records which observation strategy produced
 * it. A filesystem-only run genuinely cannot tell you whether a package opened a socket, and
 * reporting "no network activity" from such a run would be a lie by omission.
 */

const STRATEGIES = ['fsdiff', 'proxy', 'nodert', 'ebpf'];

/** What each strategy is actually capable of seeing. Used to caveat every diff it produces. */
const CAN_SEE = {
  fsdiff: { fs: true, net: false, dns: false, env: false, proc: false },
  proxy: { fs: true, net: true, dns: true, env: false, proc: false },
  // Node runtime instrumentation reaches every channel, but only through Node's own API surface —
  // a native addon or a captured reference goes underneath it. It is the only strategy that runs
  // without special infrastructure, and the only one that has actually run. See observe/probe.js.
  nodert: { fs: true, net: true, dns: true, env: true, proc: true },
  ebpf: { fs: true, net: true, dns: true, env: true, proc: true },
};

/** Ranked by how hard each is to evade. The engine asks for the best one an adapter admits to. */
const STRENGTH = ['ebpf', 'proxy', 'nodert', 'fsdiff'];

const empty = () => ({ net: [], dns: [], fs: [], env: [], proc: [] });

/* ── normalisation: strip what varies but does not mean anything ──────────── */

/**
 * Everything between a temp root and the filename varies per run — and on macOS it varies at
 * several depths at once (`/var/folders/qz/8xk_p3/T/<random>/…`), so eating a single segment is
 * not enough. Collapse the directories, keep the basename: writing to a scratch directory means
 * nothing, and writing `backdoor.sh` there means a great deal.
 */
const TEMP_DIR = /^\/(?:private\/)?(?:tmp|var\/folders)\/.*\/(?=[^/]+$)/;
const NODE_CACHE = /\/(\.npm|\.cache|node_modules\/\.cache)\/.*/;
const PID_LIKE = /\b\d{3,7}\b/g;
const HASHY = /\b[0-9a-f]{8,64}\b/gi;

function normalisePath(p) {
  return String(p)
    .replace(TEMP_DIR, '/tmp/·/')
    .replace(NODE_CACHE, '/·cache/·')
    .replace(HASHY, '·')
    .replace(PID_LIKE, '·');
}

/** Ephemeral source ports are noise; the destination is the fact. */
function normaliseNet(entry) {
  return { host: String(entry.host).toLowerCase(), port: Number(entry.port) || null, proto: entry.proto || 'tcp' };
}

function normaliseProc(entry) {
  const argv = (entry.argv || []).map((a) => normalisePath(a));
  return { argv, cmd: argv[0] || '' };
}

const uniqueSorted = (items, key) => {
  const seen = new Map();
  items.forEach((i) => seen.set(key(i), i));
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
};

/**
 * Build a transcript from raw observations.
 * Everything is sorted and de-duplicated so two identical runs compare equal.
 */
function transcript({ pkg, version, strategy, raw = {}, timing = {}, result = {} }) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown observation strategy "${strategy}". A transcript must say how it was made.`);
  }

  const r = { ...empty(), ...raw };

  return {
    pkg,
    version,
    strategy,
    canSee: CAN_SEE[strategy],
    net: uniqueSorted(r.net.map(normaliseNet), (n) => `${n.host}:${n.port}/${n.proto}`),
    dns: [...new Set(r.dns.map((d) => String(d).toLowerCase()))].sort(),
    fs: uniqueSorted(
      r.fs.map((f) => ({ path: normalisePath(f.path), op: f.op })),
      (f) => `${f.op} ${f.path}`
    ),
    env: [...new Set(r.env.map(String))].sort(),
    proc: uniqueSorted(r.proc.map(normaliseProc), (p) => p.argv.join(' ')),
    timing: { installMs: timing.installMs ?? null, importMs: timing.importMs ?? null },
    result: { installExit: result.installExit ?? null, importExit: result.importExit ?? null, threw: result.threw ?? null },
  };
}

/** Did this package do anything observable at all? */
function isQuiet(t) {
  return t.net.length === 0 && t.dns.length === 0 && t.env.length === 0 && t.proc.length === 0 && t.fs.length === 0;
}

module.exports = { transcript, isQuiet, normalisePath, STRATEGIES, STRENGTH, CAN_SEE, empty };
