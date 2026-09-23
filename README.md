<div align="center">

<br>

# Stakeout

### Your lockfile pins versions. This pins behaviour.

<br>

[**Live demo**](https://cassandra-nu.vercel.app) · [The deep dive](docs/DEEP-DIVE.md) · [For reviewers](docs/JUDGING.md) · MIT

<br>

<img src="docs/images/catch-panel.png" alt="A patch release that started reading three credentials and calling a host nothing on the open web mentions" width="860">

<br>

</div>

---

A lockfile guarantees you get `express-fileupload@2.1.1`. It guarantees **nothing** about what that
version does.

Stakeout gives every dependency its own disposable copy of a machine, installs it, imports it — and
writes down what it actually did. Then it does the same for the version you had before, from the
**identical** starting state, and diffs the two.

```
  express-fileupload@2.1.0   your lockfile, 14 Aug
  express-fileupload@2.1.1   the patch release
  ─────────────────────────────────────────────────
+ env  AWS_SECRET_ACCESS_KEY                     not in 2.1.0
+ env  GITHUB_TOKEN
+ env  NPM_TOKEN
+ net  cdn-assets-delivery.workers.dev:443
```

A patch release. The version moved by one digit; the behaviour moved a mile.

## Try it

```bash
git clone https://github.com/vidigoat/cassandra.git stakeout && cd stakeout

npm run demo        # the whole argument in a terminal, ~2 seconds
npm run check-run   # what the GitHub App posts on a pull request
npm start           # the same run in a browser, localhost:8791
npm test            # 30 suites · 410 checks
```

No `npm install`. **Zero dependencies, no build step** — a supply-chain tool that arrives with a
dependency tree is telling on itself. Node 20+.

### On your own repository, without building anything

```bash
cd ~/your-project
node ~/stakeout/cli.js lock --index https://cassandra-nu.vercel.app/index.json
```

That reads a **published index** — 1,589 packages and 2,129 versions somebody has already run,
about sixty kilobytes over the wire — and writes a `stakeout.lock` for *your* tree. Most of it will
come back **unknown**, because most of npm has never been watched by anybody, and the lock says so
by name rather than pretending to cover it.

This is the part of the argument that used to be unverifiable. "Run a package once and answer for
every repository that depends on it" was a sentence about an artefact that existed only on the
machine that built it. `npm run index:publish` writes it; the demo URL serves it; the claim can now
be wrong.

## How it stays affordable

Of a **1,214**-package tree, only the **15** whose version actually moved are re-run. Re-running the
rest would be theatre. 30 twins forked from one checkpoint; **9** model calls, not 45.

```
  lockfile ─▶ CHECKPOINT ─┬─▶ twin @ old ─▶ transcript ─┐
                          └─▶ twin @ new ─▶ transcript ─┴─▶ BEHAVIOURAL DIFF   (pure arithmetic)
                                                                   │
                Nemotron 3 Nano ─▶ Ultra ─▶ Tavily ─▶ Super ◀──────┘
                triage           meaning    the web    veto
```

Severity comes from rules in code. **A model explains a finding; it can never escalate one** — and an
accusation needs two models to agree independently.

## The same corpus, read four ways

| watching with | findings | alarming | model calls |
|---|---|---|---|
| `fsdiff` — files only | 2 | 0 | 2 |
| `proxy` — files, network, DNS | 5 | 0 | 8 |
| `ebpf` — all but code built at runtime | 5 | 1 | 9 |
| `nodert` — Node's API surface, incl. `exec` | 5 | **2** | 10 |

`nodert` finds one more than eBPF. That is not a better tool beating a worse one — it is the single
blind spot in a kernel tracer, measured: **a string becoming a function never becomes a syscall**.

The weakest observer is also the cheapest, and nothing hides that: every transcript carries what it
could not see, and silence in an unwatched channel is reported as worth nothing.

## Point it at every repo you own

A package's behaviour does not depend on who imported it, so it is observed once and looked up after
that. Pointed at a whole machine — 76 projects and 20,897 dependency-versions — 2,120 observations in
the index answered 12,986 of them, **62%**, from an index you could build in an afternoon.

<img src="docs/images/fleet.jpg" alt="A scan of turborepo drawn as a band: observed surface filled, never-observed surface hatched under a ceiling hairline" width="100%">

The scan above is the one bundled with this repository, so you can check it: turborepo: 3,107
dependency-versions across 24 readable lockfiles, which are only 1,756 distinct package-versions.
Four more lockfiles are written in a form the reader will not guess at, and are left out rather than
counted as empty. Unobserved surface is **hatched, never filled** — a fill is a quantity, and this is
the absence of one.

## What this cannot do

- **A package that was already malicious in the version you had.** This compares you to your previous
  version, not to "good". It catches the moment a package *turns* — which is how most supply-chain
  compromises arrive — and it is **not a clean-room audit**.
- **A payload that waits.** A time bomb looks exactly like an honest package.
- **A change in what the code computes.** One package in the corpus drifts **5/500** order totals by a
  cent with no observable behaviour at all. It is in the demo because a tool that only advertises its
  catches teaches you to trust a silence it has not earned.

## On the pull request

A GitHub App, authenticating as an app rather than as somebody's token — an RS256 JWT exchanged for
an installation-scoped token that expires in an hour. It reads the lockfile at the head commit and
asks the index. **It installs nothing and runs nobody's code.**

Three outcomes, and none of them is a plain pass: drift → `failure`; never-observed → **`neutral`,
never a failure**; everything observed and unchanged → `success`. A check that red-lights on the day
it is installed is switched off in week one.

```bash
npm run check-run          # see all three, no GitHub account needed
node scripts/register-app.js   # register it: one press, then it configures the live webhook itself
```

---

<div align="center">

**[The deep dive →](docs/DEEP-DIVE.md)**  ·  every decision, every bug, and the arithmetic behind each number

Built for the Nebius × NVIDIA Global AI Hackathon · Coding &amp; Agentic Engineering

</div>
