/**
 * The adapter that actually runs, on the machine you are sitting at.
 *
 * Same five methods as the other two. A "checkpoint" is a prepared directory; a "fork" is a copy of
 * it; a "branch" is a real directory where a real `npm install` happens and a real `require()` runs
 * under the probe in `observe/probe.js`.
 *
 * It is weaker than a microVM in every way that matters for security — the package runs as you,
 * on your filesystem, with your network. Nothing here contains a hostile package, and it must never
 * be pointed at something believed to be malicious. What it is good for is the thing the simulated
 * adapter cannot do: prove the pipeline end to end on real packages from the real registry.
 *
 * Use it deliberately. `STAKEOUT_ALLOW_LOCAL=1` is required, so nobody reaches for it by accident.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runnerSource, readReport } = require('../observe/probe');

const run = promisify(execFile);

class LocalMachines {
  constructor({ root, timeoutMs = 90_000 } = {}) {
    if (process.env.STAKEOUT_ALLOW_LOCAL !== '1') {
      throw new Error(
        'LocalMachines runs packages on this machine with your network and your files. ' +
          'Nothing isolates them. Set STAKEOUT_ALLOW_LOCAL=1 if that is what you meant, and never ' +
          'point it at a package you actually suspect.'
      );
    }
    this.root = root || fs.mkdtempSync(path.join(os.tmpdir(), 'stakeout-'));
    this.timeoutMs = timeoutMs;
    this.live = new Map();
    this.peakOpen = 0;
    this.runs = 0;
  }

  /**
   * Only the runtime probe. This adapter cannot see syscalls, so it must not claim to — a package
   * that reaches the network through a native addon is invisible here, and saying otherwise turns
   * "we could not see it" into "nothing happened".
   */
  get supports() {
    return ['nodert'];
  }

  /** The prepared directory every branch is copied from. */
  async boot() {
    const base = path.join(this.root, 'base');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, 'package.json'),
      JSON.stringify({ name: 'stakeout-twin', version: '1.0.0', private: true }, null, 2)
    );
    this.base = base;
    return base;
  }

  async fork(checkpoint, n) {
    const branches = [];
    for (let i = 0; i < n; i++) {
      const dir = path.join(this.root, `twin-${this.live.size}-${Date.now()}-${i}`);
      fs.cpSync(checkpoint, dir, { recursive: true });
      const branch = { id: dir, dir, from: checkpoint };
      this.live.set(branch.id, branch);
      branches.push(branch);
    }
    this.peakOpen = Math.max(this.peakOpen, this.live.size);
    return branches;
  }

  async run(branch, command, ctx = {}) {
    if (!this.live.has(branch.id)) throw new Error(`Branch ${branch.id} was discarded`);
    this.runs++;

    if (ctx.step === 'install') {
      const r = await this.sh('npm', ['install', `${ctx.pkg}@${ctx.version}`, '--no-audit', '--no-fund', '--loglevel=error'], branch.dir);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, observed: null };
    }

    if (ctx.step === 'import') {
      const runner = path.join(branch.dir, '__stakeout_runner.js');
      // Outside the branch directory, so a package rummaging through its own cwd does not find it.
      const out = path.join(this.root, `report-${path.basename(branch.dir)}.json`);
      fs.writeFileSync(runner, runnerSource(ctx.pkg, out));
      const r = await this.sh(process.execPath, [runner], branch.dir);
      // readReport returns null when the probe never reported — a crash, a timeout, a process that
      // called process.exit() itself. Null means "we did not see", never "it did nothing".
      const observed = readReport(out);
      fs.rmSync(out, { force: true });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, observed };
    }

    return { code: 0, stdout: '', observed: null };
  }

  async sh(cmd, args, cwd) {
    try {
      const { stdout, stderr } = await run(cmd, args, { cwd, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (e) {
      // A non-zero exit is a result, not an exception — a package that fails to install is a fact
      // about that version. Only a missing binary or a timeout is a genuine failure.
      if (e.code === 'ENOENT') throw new Error(`${cmd} is not on PATH`);
      return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
    }
  }

  async discard(branch) {
    this.live.delete(branch.id);
    fs.rmSync(branch.dir, { recursive: true, force: true });
  }

  get open() {
    return this.live.size;
  }

  /** Nothing of ours should outlive the run. */
  cleanup() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

module.exports = { LocalMachines };
