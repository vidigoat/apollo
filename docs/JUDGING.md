# For reviewers

Four criteria, equally weighted. This is where each is answered, and what is honestly not there
yet. Nothing below asks you to take a claim on trust — every row points at something you can run,
and a test asserts that every file named here exists.

## Start here

```bash
npm run demo      # the whole argument, in a terminal, in about two seconds
npm start         # http://localhost:8791 — one dependency tree
                  # http://localhost:8791/fleet.html — every repo on a machine
npm test          # 27 suites, 340 checks
```

The demo is the primitive: a version that did not move, behaving differently, caught. The fleet page
is the same idea at the scale where it pays for itself.

## Technological implementation
*How well is it built, and how effectively does it use Token Factory and an NVIDIA open model?*

| what to look at | where |
|---|---|
| **The behavioural lockfile** — pins what a dependency *does*, not its version | `lock.js` — `buildLock`, `checkLock`; format designed to be read in a PR diff |
| **Exit codes are the interface**: 0 clean, 1 drift, 2 unknown, 3 usage | `cli.test.js` — every one verified in a child process, because `main()` returning a number is not the claim |
| **The index** — run a package once, answer for every repo that depends on it | `index/schema.js`; a miss returns `null` and means *never observed*, never *observed, did nothing* |
| **Provenance per entry.** A simulated build cannot write into a real index, or the reverse | `index/schema.test.js` — this happened: 8,623 fabricated entries over 705 real ones |
| **Ordering the index by what it buys** — ranked by how many projects share each package-version | `scripts/index-build.js` `--from-fleet`; the curve is in the README |
| **Nemotron reads the diffs, never the packages.** Quiet ones never reach a model | `judge/index.js`; verdicts are committed JSON you can read, not a screenshot |
| Three Nemotron sizes, chosen per finding, with the reasoning tokens budgeted separately | `judge/nemotron.js` |
| **Absence is not ignorance** — a strategy's blind spots travel with every claim | `transcript/schema.js` `quietness()`, `absence.test.js` |
| Every suite reported together | `npm test` |

The one worth running yourself:

```bash
npm run fleet:scan -- ~ --out local/fleet.json
npm run index:build -- --from-fleet local/fleet.json --limit 500
npm start   # then open /fleet.html
```

Five hundred observations, chosen by how many of your projects share them, and the page will tell
you how many of your dependency-versions they answered.

**Not there yet:** the GitHub App, and the index published as an artefact rather than built locally.

## Design
*Does it deliver a complete product experience, not a proof of concept?*

| what to look at | where |
|---|---|
| **The fleet drawn rather than summarised** — every project one segment, width by dependency count | `public/fleet.js` `draw()` |
| **Absence drawn as absence.** Unwatched surface is hatching under a ceiling hairline, never a filled bar | the first version filled it and came out looking like an ordinary coverage chart |
| **The channel strip** — six slots whose third state is *nothing was watching* | `public/fleet.js` `strip()`; two of those three states get printed as "no findings" everywhere else |
| The register, not cards: rules and hairlines, one saturated colour, and it means drift | `public/fleet.css` — the "deliberately not used" list is at the top |
| A page that says whose fleet it is before the numbers, when it is showing a bundled one | `public/fleet.html` `.whose` |
| Works at 400px without the page scrolling sideways | `public/fleet.css` — the table scrolls in its own box; the page does not |

## Potential impact
*Does it solve a real problem, and could it be adopted?*

| what to look at | where |
|---|---|
| **The shape of the problem**: 20,897 dependency-versions across 76 real projects, 8,623 distinct | `README.md` → "Point it at every repo you own" |
| **The leverage**: 1,500 observations answered 11,242 of them — 54% coverage, 7.5× reuse | measured, and the 1,500 figure was predicted from the ranking before anything was installed |
| Adoption cost: zero dependencies, no build step, one command | `package.json` — there is nothing to install |
| It refuses to fail the build on *unknown* by default, because a tool that red-lights on day one is removed before it finds anything | `cli.test.js` — "check exits 2 for unknowns only when asked to" |
| A scan you can commit without publishing your home directory | `scripts/fleet-scan.js` `--portable`, `fleet.test.js` |

## Quality of the idea
*Is it novel, and is it well thought through?*

| what to look at | where |
|---|---|
| The thesis, and the primitive it reduces to | `PLAN.md` §2 |
| What this cannot do, stated rather than discovered | `README.md` → "What this cannot do" |
| The decisions that were close, with the losing option written down | `docs/decisions/` |
| What went wrong and what it cost | `docs/SUBMISSION.md` → "Challenges we ran into" |

## What is honestly not here

- **The GitHub App.** Phase 3 of `PLAN.md`, blocked on creating it.
- **A published index.** The index is built locally and gitignored; publishing it is a deliberate
  artefact, not a side effect of a commit.
- **eBPF.** `nodert` is the strategy that runs; the stronger ones are described by `CAN_SEE` and
  every claim carries which strategy made it, so nothing overstates what was watched.
