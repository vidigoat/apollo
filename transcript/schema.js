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
  fsdiff: { fs: true, net: false, dns: false, env: false, proc: false, exec: false },
  proxy: { fs: true, net: true, dns: true, env: false, proc: false, exec: false },
  /*
   * Node runtime instrumentation reaches every channel, but only through Node's own API surface —
   * a native addon or a captured reference goes underneath it. It is the only strategy that runs
   * without special infrastructure, and the only one that has actually run. See observe/probe.js.
   *
   * `exec` is the one thing it sees that eBPF cannot. Code built at runtime and handed to Function
   * or vm never becomes a syscall — it is a string turning into behaviour inside one process, and a
   * kernel tracer watches the process, not the thought. Being weaker almost everywhere and stronger
   * in exactly one place is why the strategy is worth keeping rather than replacing.
   *
   * ── `fs: 'writes'`, and why this entry used to say `true` ─────────────────
   *
   * The probe hooks writes and deletes only, deliberately: reads inside node_modules are what
   * `require` does all day and mean nothing. That is a good decision about what to RECORD and it
   * was being reported as though it were a decision about what could be SEEN.
   *
   * With `fs: true` here, every nodert transcript claimed the filesystem was watched — so a package
   * that read `~/.aws/credentials` at import time came back `quiet: true, blindTo: [],
   * trustworthy: true`. Reading a credential is the first step of the exact attack this project
   * exists to catch, and the index says 2,129 observations, 1,368 of them quiet, with not one
   * filesystem event among them. Some of that is packages genuinely writing nothing. None of it is
   * evidence that they read nothing, and the transcript was letting it read that way.
   *
   * So the value is what it is: writes, not reads. Anything other than `true` is a blind spot that
   * travels with the claim, which is what the rest of this file is for.
   */
  nodert: { fs: 'writes', net: true, dns: true, env: true, proc: true, exec: true },
  ebpf: { fs: true, net: true, dns: true, env: true, proc: true, exec: false },
};

/** Ranked by how hard each is to evade. The engine asks for the best one an adapter admits to. */
const STRENGTH = ['ebpf', 'proxy', 'nodert', 'fsdiff'];

const empty = () => ({ net: [], dns: [], fs: [], env: [], proc: [], exec: [] });

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

  // A transcript may not contain a channel its own strategy cannot see.
  //
  // This is the whole `canSee` contract made structural rather than advisory. An adapter that
  // hands back network activity from a filesystem-only run is describing something it did not
  // watch, and carrying that forward would let the differ raise a finding out of an observation
  // that never happened. Dropping it here means the caveat and the data can never disagree.
  Object.keys(r).forEach((field) => {
    if (CAN_SEE[strategy][field] === false) r[field] = [];
  });

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
    // Code that did not exist until the program was running. `how` is the mechanism (Function, vm,
    // require of something undeclared); `sample` is a short, normalised excerpt — never the whole
    // payload, which can be megabytes and is not evidence, only volume.
    exec: uniqueSorted(
      r.exec.map((e) => ({ how: String(e.how || 'unknown'), sample: normalisePath(String(e.sample || '').slice(0, 160)) })),
      (e) => `${e.how} ${e.sample}`
    ),
    timing: { installMs: timing.installMs ?? null, importMs: timing.importMs ?? null },
    result: { installExit: result.installExit ?? null, importExit: result.importExit ?? null, threw: result.threw ?? null, reported: result.reported ?? null },
  };
}

/**
 * Why a transcript is not an observation at all, or null when it is one.
 *
 * Empty channels are a claim — "watched, and it did nothing". A package whose install failed was
 * never imported, and a probe that never reported saw nothing; both come back with empty channels,
 * and both used to be written into the index as quiet. utf-8-validate@5.0.10 was the one that
 * showed it: no arm64 prebuild, no Python in the image to compile one, the install failed, and the
 * index said it read no environment — where on x86_64 its loader reads seven variables. A thing
 * nobody saw is unknown, and unknown must never be stored as clean.
 */
function unobserved(t) {
  const r = t?.result || {};
  if (r.installExit !== null && r.installExit !== undefined && r.installExit !== 0) {
    return `${t.pkg}@${t.version} did not install (npm exited ${r.installExit}), so nothing about it was seen`;
  }
  if (r.reported === false) return `the probe never reported for ${t.pkg}@${t.version}, so nothing about it was seen`;
  return null;
}

/**
 * Did we observe anything at all?
 *
 * Note what this does NOT say. It used to be called `isQuiet` and documented as "did this package
 * do anything observable" — a sentence that slides between two facts. `transcript()` deletes every
 * channel the strategy declared it cannot see, so a package that opens a socket to a host and reads
 * an AWS key, watched with `fsdiff` (which sees files and nothing else), arrives here with six
 * empty arrays and used to come back **quiet**.
 *
 * That is this project's own thesis turned against it. A tool whose whole argument is "we watched
 * and almost nothing happened" cannot let "we did not watch" and "nothing happened" share a word.
 *
 * So the function is named for what it measures — the observation was empty — and `quietness()`
 * below is the one that can be used to make a claim about the package, because it carries what the
 * strategy was blind to. Anything reporting a package as quiet must use that one.
 */
function observedNothing(t) {
  return t.net.length === 0 && t.dns.length === 0 && t.env.length === 0 && t.proc.length === 0 &&
    t.fs.length === 0 && t.exec.length === 0;
}

/**
 * Quiet, and what that claim is worth.
 *
 * A channel is either fully seen (`true`) or it is not, and "not" has two shapes: never watched at
 * all (`false`), and watched in part — `nodert` records filesystem WRITES and no reads. Both are
 * blind spots, because silence in either one supports nothing, and both have to travel with the
 * claim. `partial` names the second kind so a reader can tell them apart.
 *
 * @returns {{quiet: boolean, blindTo: string[], partial: string[], trustworthy: boolean}}
 *   quiet        nothing appeared in any channel we could see
 *   blindTo      channels where silence means nothing — unwatched, or only partly watched
 *   partial      the subset of those that were watched in part, and how
 *   trustworthy  quiet AND nothing was invisible. The only state that supports "it did nothing".
 */
function quietness(t) {
  const table = Object.entries(CAN_SEE[t.strategy] || {});
  const blindTo = table.filter(([, v]) => v !== true).map(([k]) => k);
  const partial = table.filter(([, v]) => v !== true && v !== false).map(([k, v]) => `${k} (${v} only)`);
  const quiet = observedNothing(t);
  return { quiet, blindTo, partial, trustworthy: quiet && blindTo.length === 0 };
}

module.exports = { transcript, unobserved, observedNothing, quietness, normalisePath, STRATEGIES, STRENGTH, CAN_SEE, empty };
