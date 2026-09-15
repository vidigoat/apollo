# Feedback notes — Nebius and NVIDIA tooling

Raw notes for the feedback the submission asks for. Recorded as things are observed rather than
recalled later.

Nothing here is written about a tool that has not been used yet. Token Factory inference, Nemotron and
Tavily entries will appear once keys are in and the ConTree adapter is real — writing them now would
be invention, and the point of this file is that it is trustworthy.

---

### 2026-09-15 · The Sandboxes capability is clear; the API surface is not

**What was being done:** designing an orchestrator against the fork/checkpoint model before having
access, so the adapter could be swapped in later without reshaping the engine.

**What worked:** the capability is explained well and unusually concretely. "Branch N times from any
checkpoint, run in parallel, score results" and the beam-search and best-of-N framings made it obvious
what the primitive is for, and that it is genuinely parallel across separate microVMs rather than
sequential versioning. The 50-operation concurrency limit and the 180-day checkpoint retention are
both stated plainly, which is what let the wave scheduler be written correctly first time.

**What needed work:** the SDK README shows client construction, image use, `run`, and sessions — but
no checkpoint or branch method names, no indication of whether a fork is copy-on-write, and no
fork-to-first-exec latency figure. The marketing page promises branching, the SDK docs do not show its
signatures, and `docs.contree.dev` redirects to the Token Factory docs, which describe the workflow in
prose. So the one call the whole design rests on is the one that has to be inferred.

**Severity:** medium. It does not block design — an adapter interface can be written against the
described behaviour — but it does mean the seam cannot be validated until credentials exist.

**Suggestion:** a fifteen-line snippet in the SDK README showing: reach a checkpoint, fork it N ways,
run a command in each, read the verdicts, discard. Plus one sentence on copy-on-write and one typical
fork latency. That is the difference between reading the docs and being able to start.

---

### 2026-09-15 · Onboarding is where entrants are stalling

**Observed, not experienced:** several participants on the hackathon forum are blocked at Token Factory
billing activation — a country missing from the billing list, and cards declining at verification —
which prevents redeeming the promotional credits the hackathon itself issued.

**Why it is worth reporting:** it fails at the point of highest intent, and the failure is silent
about the remedy. It is also the reason activation is the first task in our own plan rather than the
last.

**Suggestion:** for hackathon-issued promo codes, let credits be redeemed before billing verification,
or give a specific next step rather than an unavailable country list.
