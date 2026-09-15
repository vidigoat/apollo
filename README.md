# Cassandra

**Rehearse every way it breaks — before your users do.**

Cassandra forks a live, disposable twin of your service hundreds of times in parallel, breaks each copy
a different way, and reports back only the disasters it actually reproduced — each with a repro you can
replay and a fix it has already proven.

> **Status:** scaffold. This README is laid out in full so the writing and the captures drop into place.
> Sections marked `TODO` are deliberately unwritten until the thing they describe exists.

<!-- MEDIA: docs/media/hero.png — the contact sheet mid-run, three frames circled in grease-pencil red.
     This is the first thing a judge sees. It has to be the real interface, not a mockup. -->
![TODO hero](docs/media/hero.png)

---

## Contents

- [The problem](#the-problem)
- [What Cassandra does](#what-cassandra-does)
- [See it run](#see-it-run)
- [How it proves itself](#how-it-proves-itself)
- [Architecture](#architecture)
- [Built with](#built-with)
- [Run it yourself](#run-it-yourself)
- [What is real and what is simulated](#what-is-real-and-what-is-simulated)
- [For reviewers](#for-reviewers)
- [Repository map](#repository-map)
- [License](#license)

---

## The problem

`TODO` — three sentences, no throat-clearing. The shape:

1. Software dies in production from the one failure nobody rehearsed.
2. An hour of downtime runs to roughly $300,000 for a mid-size enterprise; teams meet these failures for the first time in front of customers.
3. Rehearsing hundreds of failures meant hundreds of realistic disposable environments, which nobody could afford — until forking real execution state became cheap.

---

## What Cassandra does

`TODO` — the loop, in the order it happens:

| stage | what happens |
|---|---|
| checkpoint | boot the service once, snapshot the healthy state |
| invent | a Nemotron reasoner writes adverse scenarios from your actual code, seeded by real advisories pulled through Tavily |
| fork | branch the checkpoint N times and run every scenario in parallel, in waves |
| observe | each twin runs to a real outcome — pass or fail, not a prediction |
| verify | a second, independent model family must confirm the failure, or it is not filed |
| prove | patch it, re-fork hundreds of times, and only call it fixed if every twin comes back green |
| pin | emit a permanent regression test so the failure can never return quietly |

<!-- MEDIA: docs/media/flow.gif — one uncut run: forks igniting in waves, three going red, one opening. -->

---

## See it run

`TODO` — the 90-second path a reviewer should take, written as numbered steps with the exact commands.

<!-- MEDIA: docs/media/flow.gif -->
![TODO run](docs/media/flow.gif)

---

## How it proves itself

The part that matters: **Cassandra does not report suspicions.**

`TODO` — write up the three gates, each with a screenshot:

1. **Reproduced or silent.** A scenario that did not fail is never mentioned as a risk.
2. **Independently upheld.** A second model family reviews every candidate failure; disagreement means abstain, not file.
3. **Fix proven, not proposed.** The patch is re-forked under the same scenario hundreds of times.

<!-- MEDIA: docs/media/proof.png — the evidence panel: 500/500 green, with the repro log beside it. -->
![TODO proof](docs/media/proof.png)

<!-- MEDIA: docs/media/refusal.png — the abstain card. Include this; the refusal is the trust story. -->
![TODO refusal](docs/media/refusal.png)

---

## Architecture

`TODO` — prose walkthrough pointing at real files. Keep the ASCII diagram in the README itself so it
renders without loading anything, and export the same thing to `docs/media/architecture.png` for the
submission page.

```
your app ──► CHECKPOINT ──► fork ×N (waves of 50) ──► one scenario per twin
                                   │
                              real outcome
                                   │
                          reproduced? ──no──► silent
                                   │yes
                     independent verifier ──refuse──► abstain, recorded
                                   │uphold
                           propose fix ──► re-fork ×500 ──► green? ──► FILE + PIN TEST
```

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Built with

`TODO` — fill in as each becomes real, with the specific model IDs and what each one is for.

| piece | what it does here |
|---|---|
| Nebius Token Factory Sandboxes (ConTree) | forks the twin, runs branches in parallel, holds checkpoints |
| NVIDIA Nemotron 3 Super | invents the adverse scenarios from the codebase |
| NVIDIA Nemotron 3 Ultra | root cause and patch reasoning on a failed twin |
| NVIDIA Nemotron 3 Nano | cheap triage across branch output |
| Tavily | pulls real advisories and incident write-ups that seed scenarios |

---

## Run it yourself

`TODO` — keep this to four commands or fewer. A reviewer who cannot run it in a minute will judge from
the video instead.

```bash
git clone <repo>
cd cassandra
cp .env.example .env    # NEBIUS_API_KEY, TAVILY_API_KEY — not needed for the simulated adapter
npm start               # http://localhost:8791
npm test                # scenario families + orchestrator
```

`GET /api/run` performs a real run — boots a checkpoint, forks it in waves, and lets each twin's probe
decide the verdict. `GET /api/run?clean=1` runs the same scenarios against a healthy build, which is
the one that should come back with nothing to say.

---

## What is real and what is simulated

Stated plainly, because a project that draws this line itself is easier to trust than one that makes a
reviewer go looking.

| piece | status |
|---|---|
| Orchestration — boot, fork in waves, run each twin's probe, collect verdicts | **live** (`orchestrator.js`) |
| The wave cap, and releasing every branch it forks | **live**, and tested |
| Verification — a failure is filed only once reproduced more than once | **live** |
| Scenario families and their injectors | **live** (`scenarios/`) |
| The interface, driven by a genuine run via `/api/run` | **live** |
| The sandbox itself | **simulated** (`adapters/simulated.js`) — a fixed corpus, no network, so the demo is deterministic |
| Scenario authorship by Nemotron, advisories via Tavily | stubbed — `writeScenarios()` returns the final shape, waiting on keys |
| Proposing and proving a fix by re-forking | described in the report, not yet executed |

The seam is one file. `adapters/simulated.js` out, `adapters/contree.js` in, and the same orchestration
runs against Nebius Token Factory — the engine cannot tell the difference, which is the point of the
interface it is written against.

---

## For reviewers

[`docs/JUDGING.md`](docs/JUDGING.md) maps each criterion — technological implementation, design,
potential impact, quality of the idea — to the exact file or screen that answers it, and says plainly
what is not built yet.

The short version, if you have two minutes: run `npm start`, open localhost:8791, press **Run the
pre-mortem**, click a circled frame. Then press **Run it on a healthy build** and watch it find
nothing and say so.

---

Notes toward the tooling feedback the submission asks for are in
[`docs/FEEDBACK-NOTES.md`](docs/FEEDBACK-NOTES.md), written as things are observed rather than recalled
at the end — and deliberately silent about tools that have not been used yet.

## Repository map

```
cassandra/
├── server.js            zero-dependency dev server
├── engine.js            orchestration: plan, waves, verify, prove, report
├── adapters/            sandbox backends — simulated today, ConTree next
├── scenarios/           scenario families and their injectors
├── public/              the interface
└── docs/
    ├── ARCHITECTURE.md
    ├── DEMO-SCRIPT.md   the 3-minute video, shot by shot
    ├── decisions/       short notes on choices worth defending
    └── media/           every image the README uses
```

---

## License

MIT — see [LICENSE](LICENSE).
