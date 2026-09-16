# 008 — At least one observer has to actually run

**Status:** Accepted.

## The problem it fixes

Every observation in this project was simulated. The adapter was simulated, the corpus was a
fixture, the traces were written by hand to be realistic. Everything downstream — the normaliser,
the differ, the severity rules, the judgement pipeline — was correct with respect to input that had
never been produced by a real package.

That is a design document with tests, not a working tool, and no amount of internal consistency
fixes it. The three strategies we had all needed infrastructure that does not exist yet: a guest
kernel with BPF, an egress proxy with a trusted CA, a filesystem snapshot from ConTree.

## The decision

Add a fourth strategy, `nodert`, that needs none of it. `observe/probe.js` patches `net`, `tls`,
`dns`, `child_process`, `fs` and `process.env` before `require()` runs, and records what the
package reaches for. `adapters/local.js` installs real packages into throwaway directories and runs
them under it.

```
STAKEOUT_ALLOW_LOCAL=1 npm run real
```

## What it is not

It is instrumentation, not containment. The package runs as you, with your network and your files,
and it shares a heap with the probe — so a native addon, a WebAssembly module, or code that
captured a reference to `net.Socket` before we loaded is invisible, and a determined package can
reach the report file. `STAKEOUT_ALLOW_LOCAL=1` is required so nobody reaches for this by accident,
and `canSee` plus the strategy name travel with every transcript so a weaker run can never be read
as a quiet one. The containment answer is still a microVM — decision 005, and `adapters/contree.js`.

## What it bought immediately

Two things, on the first run.

A true finding: `picocolors@1.1.1` reads `CI`, `FORCE_COLOR` and `NO_COLOR`, which `1.0.0` did not.
Checkable, on a package with forty million weekly downloads, produced by running it.

And a bug that the fixtures could never have surfaced. That diff came back `changed: true`,
severity `none`, **reasons `[]`** — the rules had no case for reading a non-sensitive environment
variable, so the interface would have said "changed" with nothing after it. A change the rules
cannot name is worse than no finding at all, because there is nothing to judge. Fixed, with a test
that every kind of change is sayable.

That is the argument for this decision in one example: a simulated corpus only ever contains the
cases you thought of.
