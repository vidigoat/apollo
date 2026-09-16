/**
 * Simulated sandboxes.
 *
 * Satisfies the same interface as the ConTree adapter, so the engine cannot tell them apart. Runs
 * against the fixed corpus with no network, which is what makes the demo deterministic and what
 * lets the whole system be built and tested before credentials exist.
 *
 * It claims to support every observation strategy because it is a simulation. The real adapter
 * will claim only what the guest actually permits, and the transcript records which one ran.
 */

const { behaviourFor } = require('../corpus');

const CHECKPOINT = 'ckpt_healthy_8f2a';

class SimulatedSandboxes {
  constructor({ behaviour = behaviourFor } = {}) {
    this.behaviour = behaviour;
    this.live = new Map();
    this.nextHandle = 0;
    this.runs = 0;
    this.peakOpen = 0;
  }

  /** What this adapter can watch. The real one will answer honestly about the guest kernel. */
  get supports() {
    return ['ebpf', 'proxy', 'fsdiff'];
  }

  async boot(image) {
    this.image = image;
    return CHECKPOINT;
  }

  async fork(checkpoint, n) {
    if (checkpoint !== CHECKPOINT) throw new Error(`Unknown checkpoint ${checkpoint}`);
    const branches = [];
    for (let i = 0; i < n; i++) {
      const handle = { id: `br_${this.nextHandle}`, index: this.nextHandle, from: checkpoint };
      this.live.set(handle.id, handle);
      this.nextHandle++;
      branches.push(handle);
    }
    this.peakOpen = Math.max(this.peakOpen, this.live.size);
    return branches;
  }

  /**
   * Run a command in a branch.
   *
   * `ctx` carries which package and version this branch is exercising, which is how the simulation
   * knows what to report. A real adapter ignores it and reports what the kernel saw.
   */
  async run(branch, command, ctx = {}) {
    if (!this.live.has(branch.id)) throw new Error(`Branch ${branch.id} was discarded`);
    this.runs++;

    if (!ctx.pkg || ctx.step !== 'import') {
      return { code: 0, stdout: '', observed: null };
    }

    // Only the import step reports behaviour — which is the point of this project.
    const b = this.behaviour(ctx.pkg, ctx.version);
    return {
      code: 0,
      stdout: '',
      observed: {
        net: b.net || [],
        dns: b.dns || [],
        fs: b.fs || [],
        env: b.env || [],
        proc: b.proc || [],
      },
    };
  }

  async discard(branch) {
    this.live.delete(branch.id);
  }

  get open() {
    return this.live.size;
  }
}

module.exports = { SimulatedSandboxes, CHECKPOINT };
