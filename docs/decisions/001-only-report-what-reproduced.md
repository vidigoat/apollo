# 001 — Only report what actually reproduced

**Decided:** 15 Sep 2026. **Status:** load-bearing. Do not soften.

## The choice

Cassandra could report everything it suspects — the way a scanner or a linter does — or only what it
made happen and watched happen. We report only the latter.

## Why

A tool that lists possibilities trains you to ignore it. Every engineer has learned to scroll past a
wall of maybes. The moment one of them was real and got skipped, the tool is worse than nothing,
because it was there and you had stopped reading.

Reproduction is what makes this different from chaos tooling and from static analysis. A failure that a
twin actually produced, with the log in front of you, is not an opinion you have to triage.

## What it costs

Recall. There will be real failures Cassandra never reproduces, and it will say nothing about them.
That is the deliberate trade: we would rather miss a failure than spend the user's attention on a
maybe. The report says how many scenarios ran, so silence is legible rather than mysterious.

## How it shows up in the product

- Scenarios that pass are counted, never listed as risks.
- A candidate failure needs a second, independent model family to uphold it before it is filed.
- A fix is not called fixed until it is re-forked and comes back green every time.
- The refusal case is shown in the interface on purpose. It is the proof that the gate is real.

## What would overturn this

Evidence that users want the maybes — that they would rather triage a long list themselves. Nothing so
far suggests that; the complaint about existing tooling is always noise, never missing breadth.
