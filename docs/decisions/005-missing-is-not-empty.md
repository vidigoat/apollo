# 005 — A missing observation is not an empty one

**Status:** Accepted. The single most important invariant in the project.

## The decision

`observed: null` means *we did not watch*. `observed: {}` means *it did nothing*. These are never
collapsed into each other, anywhere, at any layer.

## Why it matters more than it looks

Every layer has an incentive to flatten them, because flattening makes the code simpler. And every
flattening produces the same output: an empty column.

An empty column from `ebpf` means the package opened no sockets. An empty column from `fsdiff`
means **we have no idea whether the package opened sockets**, because that strategy cannot see the
network at all. Rendered identically, the second silently becomes the first, and a tool that
reports "no network activity" from a run that could not watch the network is lying — not by
overstating a finding, but by manufacturing a clean bill of health.

That is worse than a false positive. A false positive wastes an afternoon. This one gets trusted.

## Where it is enforced

- `transcript/schema.js` — every transcript carries `canSee` for the strategy that produced it
- `differ/diff.js` — every diff carries that caveat forward
- `adapters/contree.js` — a response with no trace stays `null`; a trace with no entries becomes an
  empty transcript. Tested both ways.
- `adapters/contree.js` — `supports` defaults to `['fsdiff']` only. Claiming an unproven strategy
  is the same lie with extra steps.
- `judge/prompt.js` — the prompt says, in words: *silence there means nothing*
- `public/app.js` — the page says which strategy ran and what it could not see

## What would change it

Nothing. If this invariant is inconvenient, the inconvenience is the point.
