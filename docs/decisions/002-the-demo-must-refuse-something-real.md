# 002 — The demo must refuse something real

**Decided:** 15 Sep 2026, while wiring the interface to a genuine run.

## What happened

The interface has a card headed "What it refused to tell you". It was filled from a constant: a
plausible-sounding case about an intermittent 500 under disk pressure, written by hand.

Then the orchestrator started driving the page from an actual run, and the seeded corpus produced
three failures that each reproduced two or three times. Every one was upheld. Nothing was ever
refused, so the card was describing something that had not happened.

That is precisely the failure this project exists to argue against. A tool whose evidence is partly
narrated is not better than the maybes it replaces — it is worse, because it looks like proof.

## The decision

One branch in the corpus now fails exactly **once**. The verifier sees a single observation, declines
to uphold it, and records it as unproven. The card reads that result.

The interface prefers the run's own refusal and falls back to the written copy only if a corpus
produces nothing unproven — and if that fallback is ever what a reviewer sees, the corpus is wrong,
not the card.

## What this costs

The failure count in the demo went from seven branches to eight, and the filed count stayed at three.
That gap is the point: eight things went wrong, three were proven, one was refused, and the arithmetic
is visible on screen.

## The general rule this is an instance of

Nothing in the interface may be authored prose standing in for a result. If a panel claims the system
did something, the system has to have done it in the run being displayed. When that is inconvenient,
change the run — never the copy.
