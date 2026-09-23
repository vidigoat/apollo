# For reviewers

Four criteria, equally weighted. This is where each is answered, and what is honestly not there
yet. Nothing below asks you to take a claim on trust — every row points at something you can run,
and a test asserts that every file named here exists.

## Start here

**Live:** <https://cassandra-nu.vercel.app> — the same handler this repository runs, no login.

```bash
npm run demo      # the whole argument, in a terminal, in about two seconds
npm start         # http://localhost:8791 — the site, the run, the fleet, the check run
npm test          # every suite, reported together
```

The demo is the primitive: a version that did not move, behaving differently, caught. The fleet
section is the same idea at the scale where it pays for itself.

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
| **And a blind spot corrected in the code is corrected in the data.** Every one of the 2,129 stored entries carried `fs: true` for a strategy that only watches writes — the table was fixed months ago and the entries were not, so `quietness()` weighed every claim against a visibility nobody had | `index/schema.js` `restate()`, `index/schema.test.js` — what a strategy can see is a property of the strategy, not of an observation |
| **The published index, and what it refuses to publish** — a simulated observation, and a strategy this build does not define | `scripts/publish-index.js`; `index/published.test.js` — twelve checks, including that a lookup cannot walk off the end of the package map and return the string "Object" where a transcript belongs |
| **The GitHub App** — the answer on the pull request that bumps the dependency, not in a log nobody opens | `github/webhook.js`, `github/api.js`, `github/handle.js` |
| **See what it posts, without a GitHub account** | `npm run check-run` — drives the real handler over a delivery shaped like GitHub's, with the real signature check, and prints all three check runs |
| Two-hop App auth with no dependencies: RS256 JWT → installation token, scoped and hour-long, never a personal token | `github/api.js` `appJwt`; `github.test.js` verifies the signature against its own key |
| The signature is checked against the **bytes**, before the body is believed, in constant time | `github.test.js` — a pretty-printed body with an odd key order is posted over real HTTP |
| Every suite reported together | `npm test` |

The one worth running yourself:

```bash
npm run fleet:scan -- ~ --out local/fleet.json
npm run index:build -- --from-fleet local/fleet.json --limit 500
npm start   # then open http://localhost:8791
```

Five hundred observations, chosen by how many of your projects share them, and the page will tell
you how many of your dependency-versions they answered.

**The shortest version, in a repository that has never heard of this project:**

```bash
cd ~/anything-with-a-package-lock
node ~/stakeout/cli.js lock --index https://cassandra-nu.vercel.app/index.json
```

That reads the **published index** — 4,592 packages, 7,914 versions, about 250 kB over the wire
— and writes a `stakeout.lock` for your tree. On six public projects that were **not** used to choose what was indexed — undici, bootstrap, ionic-framework, highlight.js, shelljs and cheerio — **2,705 of their 3,548 dependency-versions are answered (76%)**, up from 56% before the index was grown; the other 843 come back unknown by name. Most of any tree comes back unknown, because most of
npm has never been watched by anybody, and that is reported as its own outcome rather than as a
pass. `scripts/publish-index.js` writes the file; `index/published.js` reads it.

## Design
*Does it deliver a complete product experience, not a proof of concept?*

| what to look at | where |
|---|---|
| **The first screen is the product, performed** — two lockfile lines a patch apart, then what arrived underneath the second | `web/src/sections/Hero.jsx`; one orchestrated moment, and nothing else on the site moves by itself |
| **The fleet drawn rather than summarised** — every project one segment, width by dependency count | `web/src/sections/Fleet.jsx` |
| **Absence drawn as absence.** Unwatched surface is hatching under a ceiling hairline, never a filled bar | the first version filled it and came out looking like an ordinary coverage chart |
| The register, not cards: rules and hairlines, one saturated colour, and it only ever means drift | `web/src/styles.css` — the "deliberately not used" list is at the top |
| **The check run, in three states, with `unknown` as neutral** — the one design decision the whole adoption story rests on | `web/src/sections/Check.jsx`, asserted in `github.test.js` |
| A page that says whose fleet it is before the numbers, when it is showing a bundled one | `web/src/sections/Fleet.jsx` — `data.demo` |
| Reduced motion is respected, focus is visible, and it works at 400px without scrolling sideways | `web/src/styles.css`; every animated component reads `useReducedMotion` |

## Potential impact
*Does it solve a real problem, and could it be adopted?*

| what to look at | where |
|---|---|
| **The shape of the problem**: 20,897 dependency-versions across 76 real projects, 8,623 distinct | `README.md` → "Point it at every repo you own" |
| **The leverage**: 2,120 observations answered 12,986 of them — 62% coverage, 6.1× reuse | measured, and the 1,500-observation figure on the way there was predicted from the ranking before anything was installed |
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

- **An index of any size.** 4,592 packages is published and it is a rounding error against npm.
  The ordering work is what makes that useful — the index is built in the order of how many projects
  share each package-version, so the first 500 observations answer far more than the last 500 — but
  a tree pointed at it still comes back mostly unknown, and the tool says so rather than passing.
- **eBPF.** `nodert` is the strategy that runs; the stronger ones are described by `CAN_SEE` and
  every claim carries which strategy made it, so nothing overstates what was watched.
