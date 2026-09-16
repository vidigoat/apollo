# 006 — Triage before judgement

**Status:** Accepted.

## The decision

Three model sizes, three jobs:

| | | runs on |
|---|---|---|
| Nemotron Nano 30B | is this worth a bigger model's time? | every package that moved |
| Nemotron Ultra 550B | what is this change doing? | only what earned it |
| Nemotron Super 120B | do you independently agree? | only before an accusation |

## Why

Running the 550B on all 1,214 packages is the obvious design, and it is the one that kills the
product. Most of a dependency tree is boring, and paying frontier prices to be told so is waste
that shows up on someone's invoice as a reason to cancel.

The measured result on the reference corpus: **9 model calls for a 1,214-package tree.** Ten of the
packages that moved never reach a model at all, and the 1,200 that did not move are never
re-run in the first place — re-running what did not change is theatre.

## The subtlety

Triage is allowed to say "not worth it", but it is not allowed to be the last word on a package the
*rules* already called alarming or notable. Otherwise the cheapest model in the pipeline becomes
the one that can quietly dismiss the most serious findings, which inverts the whole authority
structure in decision 004.

`ALWAYS_JUDGE` encodes that, and `judge.test.js` asserts an alarming diff reaches the expensive
model even when triage shrugs.

## What it costs

A finding that only a large model would have noticed, on a package the rules scored as minor, is
missed. Accepted — see 004. The alternative is a tool with no economics.
