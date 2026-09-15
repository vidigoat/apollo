/**
 * Simulated sandbox adapter.
 *
 * Satisfies the same interface as the ConTree adapter so the engine cannot tell them apart. Runs
 * against a fixed corpus with no network, which is what makes the demo deterministic.
 *
 *   boot(image)            -> checkpoint id
 *   fork(checkpoint, n)    -> n branch handles, conceptually running in parallel
 *   run(branch, command)   -> { code, stdout } — a real verdict, not a guess
 *   discard(branch)        -> release it
 *
 * The one rule this file exists to preserve: the probe decides pass or fail. Nothing here asks a
 * model what it thinks happened.
 */

const CHECKPOINT = 'ckpt_healthy_8f2a';

/** Branch indexes that reproduce a failure, and which case each one belongs to. */
const FAILING = {
  37: 'F-017', 41: 'F-017',
  58: 'F-093', 96: 'F-093', 104: 'F-093',
  131: 'F-131', 168: 'F-131',
};

const OUTPUT = {
  'F-017': { code: 1, stdout: '228/500 orders drifted   INVARIANT VIOLATED' },
  'F-093': { code: 1, stdout: 'charges=2   duplicate side effect' },
  'F-131': { code: 1, stdout: 'checkout healthy at t+380s   RECOVERY LAG 290s' },
};

class SimulatedSandboxes {
  constructor({ failing = FAILING } = {}) {
    this.failing = failing;
    this.live = new Map();
    this.nextHandle = 0;
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
    return branches;
  }

  async run(branch, command) {
    if (!this.live.has(branch.id)) throw new Error(`Branch ${branch.id} was discarded`);
    const caseId = this.failing[branch.index];
    if (caseId && /probe|test/.test(command)) {
      return { code: OUTPUT[caseId].code, stdout: OUTPUT[caseId].stdout, caseId };
    }
    return { code: 0, stdout: 'ok', caseId: null };
  }

  async discard(branch) {
    this.live.delete(branch.id);
  }

  /** How many branches are still held. The engine uses this to respect the wave cap. */
  get open() {
    return this.live.size;
  }
}

module.exports = { SimulatedSandboxes, CHECKPOINT, FAILING };
