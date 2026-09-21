# Stakeout — the 10× plan

Nebius × NVIDIA Global AI Hackathon. Submissions close **30 Oct 2026, 10:00 PT** (22:30 IST).

```
written          21 Sep 2026
build days left  29–31          freeze 20–22 Oct, then record and submit
ceiling          $20,000 grand + $3,000 Tavily = $23,000
                 (one overall OR one track award, plus one bonus — the rules cap it there)
```

Judged on four **equally weighted** criteria: Technological Implementation, Design, Potential
Impact, Quality of the Idea. Ties break in that order. Our strongest axis breaks first; the problem
is reaching the tie, and Design and Impact are what keep us short of it.

---

## 1. Where this actually is, stated without flattery

**What is real and working today**

| | |
|---|---|
| the behavioural differ | pure, tested, no model involved. Severity is arithmetic |
| the `nodert` strategy | genuinely runs real packages from the real registry |
| the registry survey | 82 real upgrades, 79 behaved identically, exceptions stable under a 2× expansion |
| Nemotron, all three tiers | **live on Token Factory** since 20 Sep. Reasoning captured and shown |
| the judgement cache | a second visit costs $0.0000. Verdicts ship committed so serverless is free |
| spend ceiling | on-disk, pre-flight, fails closed |
| 23 suites, 276 checks | green, and the README cannot quote a figure a command does not produce |

**What is not**

- **It has never looked at anybody's repository.** The 1,214-package tree is a fixture and says so.
- Sandboxes has never been reached. Confirmed 404 with a working key — access, not configuration.
- There is one page. A developer cannot *use* this; they can only watch it.
- No artefact leaves the tool. Nothing to commit, nothing to diff, nothing in CI.

That last one is the whole gap. We built an argument and called it a product. A judge finishes the
video thinking *that's clever*, not *I want that*.

---

## 2. The thesis, sharpened into a primitive

The line has always been right. We have been treating it as a tagline when it should be a **file**.

```
package-lock.json    pins    express@4.18.3                        a version
stakeout.lock        pins    express@4.18.3 reads no environment
                             variable, opens no socket, spawns
                             nothing, writes only inside node_modules   a behaviour
```

You commit `stakeout.lock`. CI diffs against it. **A dependency that changes what it DOES fails your
build even when the version did not move** — which is precisely the 2024–26 supply-chain attack: a
compromised maintainer publishing a patch release that no diff and no changelog reveals.

Nobody has this primitive. It is the difference between a demo and a thing people adopt.

### Why this also solves scale

The expensive work is running a package. If we do that **once**, centrally, and publish the result,
then checking your hundredth repository is a *lookup* rather than a hundred sandbox runs.

```
                ┌───────────────────────────────────────────────┐
                │  THE INDEX                                    │
                │  behaviour(package, version, strategy)        │
                │  computed once, published as static JSON      │
                │  + a query API. Free for anyone.              │
                └───────────────────┬───────────────────────────┘
                                    │  lookup — not a run
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  stakeout CLI               GitHub App                    stakeout.dev
  `stakeout lock`            comments on your               sign in with GitHub,
  `stakeout check`           Dependabot PR, sets            connect repos, browse
  commit the lock, CI        a check run                    the index
  fails on drift
```

Three surfaces, one engine. The index is the moat; everything else is a thin client over it.

---

## 3. The economics — rewritten 21 Sep, and the constraint is gone

The first version of this section sized the index at ~1,000 packages because sandbox time looked
like it would eat the credits. Nebius's own console says otherwise:

> **Free while in beta — runs don't consume your credits.**

So **sandbox compute is not a cost constraint at all.** What bounds the index now is wall-clock
time and the documented beta limits, which is a far better problem:

```
50 concurrent operations          documented limit — "contact us if you need it lifted"
180 days checkpoint retention     far longer than this hackathon
```

At 50 concurrent forks, a package-pair taking ~40s means roughly **4,500 package-pairs an hour**.
The binding constraint is now how long we are willing to let it run, not what it costs.

```
index size        time at 50 concurrent      verdict
  1,000 pkgs      ~15 min                    trivial
  5,000 pkgs      ~70 min                    comfortable
 20,000 pkgs      ~4.5 hrs                   an overnight run
```

**Revised target: 5,000 packages, stretch 20,000.** That is 60× the current survey, and at 20,000
it is a genuine behavioural map of the part of npm that matters.

### Model spend is the only thing that costs money, and it is tiny

```
measured, 20–21 Sep       a full judgement run    9 Nemotron calls   $0.0077
                          second run (cached)     0 calls            $0.0000
                          total spend to date     171 calls          $0.1410
```

**Credit warning.** The console on 21 Sep reads **`Trial: $0.85 · 25 days`**. That is the original
$1 trial minus our $0.14 of spend — which means **the $25 promo code never actually applied**. It
is not urgent, because the index is free and judgement is pennies, but it should be chased: see
`docs/NEEDS.md`.

## 4. Phases

Dates assume Amazon has priority until its freeze on 13–15 Oct. This project gets fragments until
then and the full run after, which is why the heavy lifting sits in Phase 3 onward.

### Phase 1 · `stakeout.lock` and the CLI — the primitive (22–28 Sep)

The smallest thing that makes this a tool instead of a page.

```
stakeout lock              walk package-lock.json, look every package up in the index,
                           write stakeout.lock
stakeout check             re-read, diff against the index, exit non-zero on drift
stakeout explain <pkg>     what this package does, and where that was observed
```

- `stakeout.lock` format: JSON, one entry per package@version, the six channels, the strategy that
  observed it, and the index revision it came from. **Human-diffable** — that is the whole point,
  so a reviewer can read the change in a PR.
- `stakeout check` must distinguish three outcomes, not two: **drift** (behaviour changed),
  **unknown** (not in the index — say so, do not pass silently), **clean**.
- Exit codes: `0` clean, `1` drift, `2` unknown-and-configured-to-fail.

**Done when:** `npx stakeout lock && npx stakeout check` runs green in a real repository of Vidit's,
and deliberately introducing a package the index has never seen produces `unknown`, not a pass.

**Why this is first:** every other surface is a client of it, and it is the one piece that works
with no Sandboxes, no hosting, and no auth.

### Phase 2 · The index at scale (29 Sep – 12 Oct, in fragments)

- Package selection: top ~5,000 by download count, taken from the registry, **published as a list
  with the query that produced it** so nobody has to trust our sampling.
- Adjacent-version pairs derived by `npm run pairs` — already built, already enforces
  publication-order adjacency, forward semver, at most one major apart.
- Runner: resumable, idempotent, writes one JSON file per package-version, content-addressed.
  It must survive being killed and restarted — this will run for hours.
- **Cost governor**: the existing `judge/budget.js` pattern extended to sandbox spend. A hard
  ceiling, pre-flight, fails closed. It stops before the credits do.
- Output: `index/` — static JSON, servable from anywhere, plus a single manifest with the revision.

**Done when:** the index holds ≥2,000 packages, `stakeout check` resolves against it without a
network call to us, and re-running the builder costs nothing for packages already done.

**Sandboxes dependency:** see §6. There is a fallback and it is not fatal.

### Phase 3 · The GitHub App (13–17 Oct)

Where the decision actually gets made. A developer does not visit a dashboard; they look at a PR.

- Installation is the auth. No login screen, no account system, no password reset.
- On a PR that changes a lockfile: resolve both sides against the index, comment with the
  behavioural diff, set a **check run** so it can be made required.
- The comment must be *small*. One line per changed package, the alarming one expanded, a link for
  the rest. A wall of text gets muted and muted is dead.
- Silence when nothing changed. A bot that comments "no issues found" on every PR is uninstalled
  within a week.

**Done when:** it is installed on a real repository, a real Dependabot PR gets a real comment, and
a screen recording of that exists.

### Phase 4 · stakeout.dev — the web surface (18–20 Oct)

- **Sign in with GitHub** (OAuth). Justified because we genuinely need to read lockfiles, not
  because products have login pages.
- Three screens, no more:
  - **Repos** — connected repositories, last check, drift count. Dense, sortable, no cards.
  - **A run** — the wall we already have, now over *their* dependencies.
  - **The index** — search any package, see what it does at every version, with the evidence.
- The index browser is the public-good surface and needs no login. It should be linkable and
  indexable; it is the thing people will share.

**Done when:** a stranger can sign in, connect a repo, and get a real answer in under ninety seconds.

### Phase 5 · Design (throughout, concentrated 18–20 Oct)

Not a phase so much as a standing constraint, but the concentrated pass sits here.

- Real brand assets from official press kits only — Nebius, NVIDIA. **Never a redrawn logo.**
- The look is an instrument: dense, small type, a lot of real data. Linear and Datadog, not a
  landing page.
- Banned: gradient hero, three-column feature grid, emoji-as-icon, big-number-small-label,
  `01 / 02 / 03` step markers, tracked-out ALL-CAPS eyebrows. These are the tells.
- One signature motion, already chosen: the fork strip going quiet, one row keeping its colour.
- `~/hackathon-design` is the studio; `node check.js` there verifies every colour and typeface it
  claims against this repository's actual CSS. **The product is the source of truth; the mockup is
  what gets corrected.**

### Phase 6 · Freeze (20–22 Oct), then record and submit

- Freeze means no new capability. Review, polish, record, fill the form.
- Repo goes **public** with the MIT licence already in place — Nebius requires it.
- Demo URL deployed (`DEPLOY.md`, two commands).
- `docs/FEEDBACK-NOTES.md` finalised — the Most Valuable Feedback prize is judged on completeness,
  viability and impact, and three strong entries already exist.
- Tavily: a functional runtime call is the whole criterion for $3,000. It is already written and
  waiting for a key.

---

## 5. Cut order — what dies first

A plan without this is a wish list. When time runs out, in this order:

```
1st to go    the index browser UI      the index still exists and the CLI still uses it
2nd          stakeout.dev entirely     the GitHub App is the better demo anyway
3rd          index size 5,000 → 500    still 6× the current survey, still honest
4th          the GitHub App            falls back to the CLI plus a recorded run
NEVER cut    stakeout.lock + check     without the primitive this is a demo again
NEVER cut    the honesty machinery     labelled estimates, canSee caveats, the absence tests
```

The last line is not sentiment. The project's entire argument is that it does not overclaim, and
every test enforcing that is load-bearing for the pitch.

---

## 6. Risks, and what we do about each

**Sandboxes access never arrives.** *Likely.* Confirmed 404 with a working key on 20 Sep, so it is a
queue, not a misconfiguration.
→ **Fallback:** build the index with the `nodert` strategy locally. It is real, it already runs real
packages, and it is the strategy that produced every finding we have. It is slower and weaker
(Node's API surface only — a native addon goes underneath it), and the index records the strategy
per entry, so nothing silently overclaims. **This is not fatal.** It changes the index from
"kernel-level" to "runtime-level" and the honesty machinery already handles saying so.

**The index run takes longer than expected.** Sandboxes are free in beta, so cost is no longer the
limit — wall clock and the 50-concurrent cap are. → The builder is resumable and content-addressed,
so it can be stopped and restarted across days, and 500 packages is already a perfectly good index.

**A package does something destructive when run.** → Sandboxes are isolated; locally, `nodert`
already requires `STAKEOUT_ALLOW_LOCAL=1` and warns that it executes packages as you. The hosted
demo deliberately refuses `/api/real` entirely.

**GitHub App review/approval delays.** → A GitHub App in development mode works on your own repos
without review. Only public listing needs approval, and we do not need public listing.

**Spreading too thin across two hackathons.** *The real risk.* → Amazon freezes seven days earlier.
It gets priority until 15 Oct; this project gets the clean run 15–22 Oct. The phases above are
ordered so that Phase 1 (the primitive) is done early and cheaply, which means even the worst case
ships something new.

---

## 7. What the submission has to contain

| required | state |
|---|---|
| runtime call to Token Factory + an NVIDIA open model | **live** — three Nemotron tiers, verified by `npm run preflight` |
| public repo, OSS licence | MIT in place; **must be flipped public at submission** |
| README with setup | yes, and every figure in it is checked by a command |
| working demo URL | `DEPLOY.md`, two commands, costs nothing per visitor |
| ≤3 min YouTube video with audio | `docs/DEMO-SCRIPT.md`, shot list numbered |
| feedback on Nebius/NVIDIA tools | `docs/FEEDBACK-NOTES.md` — three substantial entries |
| what changed during the window | built in it |
| **Best Use of Tavily — $3,000** | judged on a *functional runtime call*. Written, needs a key |

---

## 8. Measurable targets

These are what "10×" means in numbers rather than adjectives.

```
                             today          target        floor (acceptable)
index size                   0              5,000 pkgs    500 pkgs
repos it can check           0              unlimited     1 real repo, live
surfaces                     1 page         CLI+App+web   CLI + App
Nemotron                     live ✓         live ✓        live ✓
cost per additional repo     n/a            $0 (lookup)   $0
tests                        276            400+          keep green
```

---

## 9. What is needed from Vidit

See `docs/NEEDS.md` — one list, both projects, ordered by what blocks what.
