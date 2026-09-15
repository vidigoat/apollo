# Working in this repository

Read this before changing anything. Written for whoever picks the work up next, human or agent.

## What this is

Cassandra forks a live twin of a service hundreds of times in parallel, breaks each copy a different
way, and reports only the failures that actually reproduced — with a fix proven by re-forking.
Submission for the Nebius × NVIDIA Global AI Hackathon. Deadline **30 Oct 2026, 10:00 PT**.

## The one rule that decides the project

**Nothing is reported unless a twin actually failed.**

Chaos tools list what might go wrong. Cassandra only speaks about what it made go wrong and watched
happen. Three gates enforce it, and none of them are negotiable for the sake of a nicer demo:

1. A scenario that did not fail is never surfaced as a risk.
2. A failure is filed only if a second, independent model family upholds it. Disagreement means abstain.
3. A fix is called fixed only after re-forking hundreds of times and coming back green every time.

If a change makes the report longer but the evidence thinner, it is the wrong change.

## Non-negotiables for the submission

1. **A real runtime call to Nebius Token Factory** (or AI Cloud) and **at least one NVIDIA open model**.
2. **Public repository, open-source licence visible on the repo page, README with setup steps.**
3. **Demo video under three minutes, public on YouTube, with narration that names Token Factory and the
   Nemotron model used.**
4. **The live demo has to stay reachable through the judging window** (1–15 Dec) — do not take the host
   down in November.
5. Feedback on Nebius and NVIDIA tooling is part of the submission.

## Layout

| path | what belongs there |
|---|---|
| `engine.js` | orchestration only: planning waves, dispatching forks, the verify gate, the proof loop |
| `adapters/` | sandbox backends. `simulated.js` today, `contree.js` next. Same interface, nothing else changes |
| `scenarios/` | scenario families and their injectors. Adding a family must not require touching the engine |
| `public/` | the interface |
| `docs/decisions/` | short notes on choices worth defending |

## Conventions

- Node, zero dependencies, no build step.
- The adapter interface is the seam that matters. If engine code starts knowing about ConTree specifics,
  push that back into the adapter.
- Wave size is capped at 50 — Sandboxes limits simultaneous operations. Do not raise it hopefully.
- Log lines shown in the UI are real output from the run, never prettified summaries.
- Cost is displayed because it is part of the argument. Keep the accounting honest.

## Where the demo must not drift

The seeded corpus reproduces three failures — a dependency bump that corrupts totals, an idempotency
race that double-charges, and a retry storm that turns a 90-second dependency outage into a six-minute
one. Each mirrors a real, documented incident class. Keep that mapping; it is why the demo reads as
serious rather than invented.

## Definition of done for any change

- A full run still completes and the filed count still matches the circled frames.
- The abstain case still appears — the refusal is the trust story.
- If you touched the adapter interface, both adapters still satisfy it.
