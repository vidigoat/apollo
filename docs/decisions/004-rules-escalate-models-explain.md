# 004 — Rules escalate, models explain

**Status:** Accepted. Enforced in code and in tests.

## The decision

Severity is decided by about thirty lines of arithmetic in `differ/diff.js`. A model may **explain**
a finding, and may **talk one down** — "the changelog documents this endpoint". A model may never
talk one **up**.

## Why

Two reasons, and only the second is about safety.

**Reproducibility.** A set difference over two transcripts is arithmetic. Anyone reading the
repository can re-run it and get the same answer. The moment severity depends on a model's mood, a
finding stops being checkable and becomes an assertion — and a security tool nobody can audit is
just a different kind of trust-me.

**Blast radius.** This tool's output is an accusation against a named human's package. A false
positive is not a bug report, it is a defamation with a CI badge on it. The day this wrongly
accuses a real maintainer of shipping malware is the day it stops being installed — so the ceiling
on severity has to be something a person can read in one sitting and argue with.

## How it is enforced

- Quiet diffs never reach a model. There is no evidence to reason about and nothing to escalate.
- `judgeOne` returns the rules' severity unchanged in every branch, including after a verdict.
- An accusation additionally requires a *second* model, from a different size class, to agree
  independently. One model is an opinion.
- Any reply that is not exactly the verdict shape is discarded, not salvaged.

## What it costs

Genuine findings the rules do not encode will be missed. That is accepted: a missed finding is a
gap, an invented one is a liability.
