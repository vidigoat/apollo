/**
 * Nebius Token Factory Sandboxes — the real thing.
 *
 * Same five methods as the simulated and local adapters, so nothing above this file knows which one
 * it is talking to.
 *
 * ── How this was wrong for a week, and how that was found ───────────────────
 *
 * The first version of this file was written against an API that did not exist. It called
 * `https://api.studio.nebius.com/v1/sandboxes` with `/exec`, `/checkpoint` and `/fork` — every one
 * of them a guess — and every call came back 404. Preflight printed "expected until access is
 * granted", which was a plausible reading of a 404 and a completely wrong one: the host was wrong,
 * the paths were wrong, and the one header the service requires was never sent. A 404 from a guess
 * is indistinguishable from a 404 from a closed door, and for a week it was read as the second.
 *
 * Everything below is taken from the official client, `contree-sdk` 0.3.6 on PyPI, rather than
 * inferred: the host, the `Project` header, the routes, the request and operation shapes. Asked
 * correctly, the service answered on the first try — HTTP 200 from `/v1/whoami` — and said
 * precisely what the real situation is: authenticated, 50 concurrent instances allowed, and every
 * permission (`spawn`, `import`, `list`) still false. That is a fact somebody can act on. "404" was
 * not.
 *
 * ── The model: images and instances, not machines ───────────────────────────
 *
 * ConTree has no long-lived machine to exec into. Every command runs in a fresh microVM started
 * from an IMAGE, and a run that is not disposable produces a new image holding whatever the command
 * left behind. So the vocabulary this project already used maps onto it exactly:
 *
 *     boot      import node:22, run the setup once, upload the probe   → image  = the CHECKPOINT
 *     fork      N twins are N references to that one image             (free — nothing is copied)
 *     install   `npm install pkg@v` from the twin's image               → new image for that twin
 *     import    run the probe from that image, report written to a file → read the file back OUT
 *               of the image the run produced, via /v1/inspect/{uuid}/download
 *     discard   drop the reference
 *
 * The report travels as a file on purpose. Anything a package prints to stdout it can also forge —
 * a `process.on('exit')` handler runs after the probe does — so the probe writes its report outside
 * the package's own directory, and this adapter reads that file out of the image rather than
 * trusting the process's output. Locally that was a partial defence, because the package and the
 * probe share a heap; inside a microVM whose disk is read back after the process is gone, it is the
 * containment story the project always said it needed.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { runnerSource, parseReport } = require('../observe/probe');

/** The production endpoint, as the official SDK defines it (`ContreeEndpoint.TOKEN_FACTORY_SANDBOXES`). */
const BASE = (process.env.NEBIUS_SANDBOX_URL || 'https://api.tokenfactory.nebius.com/sandboxes').replace(/\/+$/, '');

const FINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

/** Where things live inside every twin. Outside the package's own directory, by design. */
const IN_VM = {
  twin: '/twin',
  probe: '/stakeout/probe.js',
  runner: '/twin/__stakeout_runner.js',
  report: '/stakeout/report.json',
};

/** Observation needs particular things from a guest. If we cannot get them, say so instead of reporting silence. */
const STRATEGY_REQUIREMENTS = {
  nodert: 'nothing beyond Node itself — the probe is uploaded into the image and loaded by the runner',
  ebpf: 'a guest kernel with BPF enabled and CAP_BPF in the sandbox',
  proxy: 'an egress proxy the sandbox routes through, plus a trusted CA in the guest',
  fsdiff: 'nothing special — filesystem snapshots before and after',
};

/*
 * The probe's own source, exactly as written — it is what runs inside the sandbox.
 *
 * On a deployment the function is compiled: observe/probe.js ships as probe.cjs, rewritten to need a
 * bundler runtime that does not exist inside a microVM, and the hosted watch failed twice on it
 * (ENOENT, then "Cannot find module"). So a verbatim copy ships as public/probe.source.txt, which
 * is not compiled, and a test fails if it ever differs from observe/probe.js.
 */
function probeSource() {
  const original = path.join(__dirname, '..', 'observe', 'probe.js');
  if (fs.existsSync(original)) return fs.readFileSync(original);
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'probe.source.txt'));
}

/*
 * An image reference as the import endpoint wants it: an absolute `docker://` URL.
 *
 * `docker.io/library/node:22-slim` was refused with "Image URL must be absolute" the first time a
 * permitted key reached the endpoint. The SDK normalises every reference to
 * `docker://<host>/<path>` — a bare name gets docker.io and, for docker.io, the `library/`
 * namespace — so this does the same (contree_sdk/utils/oci.py, OCIReference.from_oci).
 */
function ociUrl(ref) {
  let r = String(ref);
  if (!r.includes('://')) r = `docker://${r}`;
  const m = /^docker:\/\/(.*)$/.exec(r);
  if (!m) throw new Error(`not a docker image reference: ${ref}`);
  let [host, ...rest] = m[1].split('/');
  let pathPart = rest.join('/');
  // No path at all means the whole thing is the path ("python:3.12-slim" has a dot, not a host).
  if (!rest.length || !host.includes('.')) { pathPart = rest.length ? `${host}/${pathPart}` : host; host = 'docker.io'; }
  if (host === 'docker.io' && !pathPart.includes('/')) pathPart = `library/${pathPart}`;
  return `docker://${host}/${pathPart}`;
}

class ConTreeSandboxes {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]      NEBIUS_API_KEY
   * @param {string} [opts.projectId]   NEBIUS_PROJECT_ID — sent as the `Project` header, which the
   *                                    service requires and the first version never sent
   * @param {string} [opts.image]       the base image to import, e.g. docker.io/library/node:22-slim
   * @param {number} [opts.timeoutSec]  per-operation timeout; the account's ceiling is 3,600
   */
  constructor({
    apiKey = process.env.NEBIUS_API_KEY,
    projectId = process.env.NEBIUS_PROJECT_ID,
    image = 'docker.io/library/node:22-slim',
    timeoutSec = 300,
    fetchImpl,
    sleep,
    pollMs = 250,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        'ConTreeSandboxes needs NEBIUS_API_KEY. Use SimulatedSandboxes for the offline demo — ' +
          'it satisfies the same interface, and the transcript records which one ran.'
      );
    }
    if (!projectId) {
      throw new Error(
        'ConTreeSandboxes needs NEBIUS_PROJECT_ID — the `Project` header the service requires. ' +
          'It is on the Sandboxes page in the Token Factory console, under Playground.'
      );
    }
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.image = image;
    this.timeoutSec = timeoutSec;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = pollMs;
    this.live = new Map();
    this.peakOpen = 0;
    this.runs = 0;
    this.probeFile = null;
  }

  /** nodert runs inside the guest exactly as it does locally — it is Node code, uploaded. */
  get supports() {
    return ['nodert'];
  }

  static why(strategy) {
    return STRATEGY_REQUIREMENTS[strategy] || 'unknown strategy';
  }

  /* ── transport ────────────────────────────────────────────────────────── */

  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.apiKey}`,
      project: this.projectId,
      'user-agent': 'stakeout',
      ...extra,
    };
  }

  async api(route, { method = 'GET', json, bytes, raw = false } = {}) {
    const res = await this.fetch(`${BASE}${route}`, {
      method,
      headers: this.headers(
        json !== undefined
          ? { 'content-type': 'application/json' }
          : bytes
            ? { 'content-type': 'application/octet-stream' }
            : {}
      ),
      body: json !== undefined ? JSON.stringify(json) : bytes,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`sandboxes ${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * Who the service thinks we are, and what it will let us do.
   *
   * The first call worth making, and the one that turned a week of "404, probably no access yet"
   * into a sentence with facts in it.
   */
  whoami() {
    return this.api('/v1/whoami');
  }

  /**
   * Start an operation and wait for it to finish.
   *
   * Polls with a gently growing interval, as the SDK does. A FAILED or CANCELLED operation is
   * returned rather than thrown — a command that exits non-zero is a result about a package, not a
   * fault in the adapter — and only a timeout or a transport error throws.
   */
  async operation(uuid) {
    const deadline = Date.now() + (this.timeoutSec + 30) * 1000;
    let wait = this.pollMs;
    for (;;) {
      let op = null;
      try {
        op = await this.api(`/v1/operations/${uuid}`);
      } catch (e) {
        // A just-created operation can briefly 404 before the service has registered it.
        if (e.status !== 404) throw e;
      }
      if (op && FINAL.has(String(op.status).toUpperCase())) return op;
      if (Date.now() > deadline) throw new Error(`operation ${uuid} did not finish within ${this.timeoutSec}s`);
      await this.sleep(wait);
      wait = Math.min(wait * 1.6, 5000);
    }
  }

  /** Upload a file once; it is addressed by content afterwards. */
  async upload(buf) {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    try {
      return await this.api(`/v1/files/${sha}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    return this.api('/v1/files', { method: 'POST', bytes: buf });
  }

  /**
   * One command, in one fresh microVM, from one image.
   *
   * @returns {{ code, stdout, stderr, image, status, error }} — `image` is the image the run left
   *   behind (null for a disposable run), which is how state moves from one step to the next.
   */
  async spawn({ image, command, args = [], files = {}, disposable = false, cwd = '', env = {} }) {
    this.runs++;
    const { uuid } = await this.api('/v1/instances', {
      method: 'POST',
      json: {
        command,
        args,
        image,
        hostname: 'twin',
        shell: false,
        env,
        cwd,
        disposable,
        stdin: { value: '', encoding: 'ascii' },
        timeout: this.timeoutSec,
        truncate_output_at: 256 * 1024,
        files,
        preserve_env: false,
      },
    });
    const op = await this.operation(uuid);
    const result = op.metadata?.result || null;
    return {
      status: String(op.status).toUpperCase(),
      error: op.error || null,
      code: result?.state?.exit_code ?? (String(op.status).toUpperCase() === 'SUCCESS' ? 0 : 1),
      timedOut: Boolean(result?.state?.timed_out),
      stdout: decodeStream(result?.stdout),
      stderr: decodeStream(result?.stderr),
      image: op.result?.image || null,
    };
  }

  /* ── the adapter interface ────────────────────────────────────────────── */

  /**
   * Import Node, set it up once, and upload the probe — the one image every twin starts from.
   *
   * Everything done here is done once and is identical for both sides of every pair, which is what
   * makes it safe to do at all: a difference between two twins can then only be the package.
   */
  async boot(ref = this.image) {
    const imported = await this.api('/v1/images/import', {
      method: 'POST',
      json: { registry: { url: ociUrl(ref) }, tag: null, timeout: this.timeoutSec },
    });
    const op = await this.operation(imported.uuid);
    if (String(op.status).toUpperCase() !== 'SUCCESS') {
      throw new Error(`importing ${ref} failed: ${op.error || op.status}`);
    }
    const base = op.result?.image;
    if (!base) throw new Error(`importing ${ref} returned no image`);

    this.probeFile = await this.upload(probeSource());

    const setup = await this.spawn({
      image: base,
      command: 'sh',
      args: [
        '-c',
        `mkdir -p ${IN_VM.twin} /stakeout && cd ${IN_VM.twin} && ` +
          `printf '{"name":"stakeout-twin","version":"1.0.0","private":true}' > package.json && ` +
          'npm config set fund false && npm config set audit false',
      ],
      files: { [IN_VM.probe]: fileSpec(this.probeFile, '0444') },
    });
    if (setup.code !== 0 || !setup.image) {
      throw new Error(`setting up the checkpoint failed (exit ${setup.code}): ${setup.stderr.slice(0, 200)}`);
    }
    this.checkpoint = setup.image;
    return setup.image;
  }

  /** N twins from one checkpoint. Nothing is copied — each is a reference to the same image. */
  async fork(checkpoint, n) {
    const branches = Array.from({ length: n }, (_, i) => ({
      id: `twin-${this.runs}-${this.live.size}-${i}`,
      from: checkpoint,
      image: checkpoint,
    }));
    for (const b of branches) this.live.set(b.id, b);
    this.peakOpen = Math.max(this.peakOpen, this.live.size);
    return branches.map((b) => ({ id: b.id, from: b.from }));
  }

  /**
   * One step in one twin.
   *
   * `install` runs npm and carries the resulting image forward. `import` runs the probe and reads
   * the report back out of the image the run left behind. `observed` is null whenever there is no
   * report to read — a crash, a timeout, a package that deleted it — because a missing observation
   * must never be flattened into an empty one: empty means "it did nothing", missing means "we did
   * not watch".
   */
  async run(branch, _command, ctx = {}) {
    const twin = this.live.get(branch.id);
    if (!twin) throw new Error(`Branch ${branch.id} was discarded`);

    if (ctx.step === 'install') {
      const r = await this.spawn({
        image: twin.image,
        command: 'npm',
        args: ['install', `${ctx.pkg}@${ctx.version}`, '--no-audit', '--no-fund', '--loglevel=error'],
        cwd: IN_VM.twin,
      });
      if (r.image) twin.image = r.image;
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, observed: null };
    }

    if (ctx.step === 'import') {
      const runner = await this.upload(
        Buffer.from(runnerSource(ctx.pkg, IN_VM.report, IN_VM.probe))
      );
      const r = await this.spawn({
        image: twin.image,
        command: 'node',
        args: [IN_VM.runner],
        cwd: IN_VM.twin,
        files: { [IN_VM.runner]: fileSpec(runner, '0444') },
      });

      let observed = null;
      if (r.image) {
        try {
          const bytes = await this.api(
            `/v1/inspect/${r.image}/download?path=${encodeURIComponent(IN_VM.report)}`,
            { raw: true }
          );
          observed = parseReport(bytes.toString('utf8'));
        } catch (e) {
          if (e.status !== 404) throw e; // no report: we did not see, which is not the same as nothing
        }
      }
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, observed };
    }

    return { code: 0, stdout: '', stderr: '', observed: null };
  }

  /** Give the twin back. Images are the service's to collect; the slot is ours to free. */
  async discard(branch) {
    this.live.delete(branch.id);
  }

  get open() {
    return this.live.size;
  }
}

const fileSpec = (uploaded, mode) => ({ uuid: uploaded.uuid, mode, uid: 0, gid: 0 });

/** A stream as the service returns it: base64 unless it says otherwise. */
function decodeStream(s) {
  if (!s || typeof s.value !== 'string') return '';
  if (String(s.encoding || 'base64').toLowerCase() === 'ascii') return s.value;
  try {
    return Buffer.from(s.value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { ConTreeSandboxes, STRATEGY_REQUIREMENTS, BASE, IN_VM, decodeStream, ociUrl, probeSource };
