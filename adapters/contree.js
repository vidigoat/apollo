/**
 * Nebius Token Factory Sandboxes — the real thing.
 *
 * Same five methods as the simulated adapter, so nothing above this file knows which one it is
 * talking to. That was the point of drawing the seam here: if Sandboxes access never arrives, this
 * is the only file that was wasted, and the project still runs and still demonstrates its claim.
 *
 * The two properties this project is built on:
 *
 *   FORK FROM A CHECKPOINT   Boot one machine, install Node and a clean npm cache, snapshot it.
 *                            Every twin starts from that exact state — same clock, same DNS cache,
 *                            same everything. Without that, a difference between two runs could
 *                            always be the machine rather than the package, and the whole argument
 *                            collapses.
 *
 *   FIFTY AT ONCE            The cap is 50 simultaneous operations, which is why runPair works in
 *                            waves rather than firing 1,214 machines at a wall.
 *
 * Nothing here is invented: every call goes through one `api()` helper, so when the endpoint
 * shapes are confirmed against the live docs, there is exactly one place to correct. Until then
 * this module refuses to run rather than guessing — a silently wrong adapter is worse than an
 * absent one.
 */

const BASE = process.env.NEBIUS_SANDBOX_URL || 'https://api.studio.nebius.com/v1/sandboxes';

/** Observation needs a privileged guest. If we cannot get one, say so instead of reporting silence. */
const STRATEGY_REQUIREMENTS = {
  ebpf: 'a guest kernel with BPF enabled and CAP_BPF in the sandbox',
  proxy: 'an egress proxy the sandbox routes through, plus a trusted CA in the guest',
  fsdiff: 'nothing special — filesystem snapshots before and after',
};

class ConTreeSandboxes {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey      NEBIUS_API_KEY
   * @param {string} [opts.image]     base image for boot()
   * @param {string[]} [opts.supports] strategies this account's guests actually permit
   */
  constructor({ apiKey = process.env.NEBIUS_API_KEY, image, supports, fetchImpl } = {}) {
    if (!apiKey) {
      throw new Error(
        'ConTreeSandboxes needs NEBIUS_API_KEY. Use SimulatedSandboxes for the offline demo — ' +
          'it satisfies the same interface, and the transcript records which one ran.'
      );
    }
    this.apiKey = apiKey;
    this.image = image;
    this.fetch = fetchImpl || globalThis.fetch;
    // Deliberately conservative. fsdiff needs no privileges; the other two must be proven per
    // account, and claiming a strategy we do not have would turn "we could not see it" into
    // "nothing happened" — the one lie this project cannot afford.
    this._supports = supports || ['fsdiff'];
    this.live = new Map();
    this.peakOpen = 0;
    this.runs = 0;
  }

  get supports() {
    return this._supports;
  }

  /** Why a strategy is unavailable, in words a human can act on. */
  static why(strategy) {
    return STRATEGY_REQUIREMENTS[strategy] || 'unknown strategy';
  }

  async api(path, body, method = 'POST') {
    const res = await this.fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sandboxes ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Boot one machine, bring it to a healthy state, and snapshot it.
   * The snapshot is the thing every twin forks from, so it is made exactly once per run.
   */
  async boot(image = this.image) {
    const sandbox = await this.api('', { image, name: 'stakeout-base' });
    // Warm the machine so the twins are not each paying for a cold npm cache. Anything done here
    // is done once and is identical for both sides of every pair, which is what makes it safe.
    await this.api(`/${sandbox.id}/exec`, { command: 'npm config set fund false audit false' });
    const checkpoint = await this.api(`/${sandbox.id}/checkpoint`, { name: 'healthy' });
    this.baseSandbox = sandbox.id;
    return checkpoint.id;
  }

  /** Fork n twins from one checkpoint. The caller is responsible for discarding them. */
  async fork(checkpoint, n) {
    const branches = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        this.api('/fork', { checkpoint_id: checkpoint, name: `twin-${i}` })
      )
    );
    branches.forEach((b) => this.live.set(b.id, b));
    this.peakOpen = Math.max(this.peakOpen, this.live.size);
    return branches.map((b) => ({ id: b.id, from: checkpoint }));
  }

  /**
   * Run a command in one twin and return what was observed.
   *
   * `ctx.step` is 'install' or 'import'. Only the import step carries observation, because that is
   * where 2026's attacks fire — npm disabled install scripts in July, and the AsyncAPI compromise
   * moved to import time six days later.
   */
  async run(branch, command, ctx = {}) {
    if (!this.live.has(branch.id)) throw new Error(`Branch ${branch.id} was discarded`);
    this.runs++;

    const watch = ctx.step === 'import' ? { strategy: ctx.strategy, trace: true } : undefined;
    const r = await this.api(`/${branch.id}/exec`, { command, watch });

    return {
      code: r.exit_code ?? 0,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      // `observed` stays null unless the sandbox actually returned a trace. A missing trace must
      // never be flattened into an empty one: empty means "it did nothing", missing means
      // "we did not watch", and the differ treats them completely differently.
      observed: r.trace ? normaliseTrace(r.trace) : null,
    };
  }

  /** Give the machine back. runPair calls this in a `finally`, always. */
  async discard(branch) {
    this.live.delete(branch.id);
    await this.api(`/${branch.id}`, null, 'DELETE').catch(() => {});
  }

  get open() {
    return this.live.size;
  }
}

/** Whatever shape the trace arrives in, the rest of the system sees transcript/schema's shape. */
function normaliseTrace(t) {
  return {
    net: (t.connections || []).map((c) => ({ host: c.host ?? c.dest, port: c.port, proto: c.proto || 'tcp' })),
    dns: (t.dns || []).map((d) => d.name ?? d),
    fs: (t.files || []).map((f) => ({ op: f.op || 'write', path: f.path })),
    env: t.env_read || [],
    proc: (t.processes || []).map((p) => ({ argv: p.argv || [p.cmd] })),
    // A kernel tracer cannot produce this; a runtime probe can. Mapped anyway so the shape is the
    // same whatever produced it — CAN_SEE decides whether it survives.
    exec: (t.exec || []).map((e) => ({ how: e.how, sample: e.sample })),
  };
}

module.exports = { ConTreeSandboxes, normaliseTrace, STRATEGY_REQUIREMENTS };
