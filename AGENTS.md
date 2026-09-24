# Working in this repository

Read this before changing anything. Written for whoever picks the work up next, human or agent.

## What this is

**Stakeout** watches what a dependency *does* — at import and while its install scripts run — in
Nebius Token Factory Sandboxes, and records it in a behavioural index anybody can check a lockfile
against. An upgrade is watched as two twins forked from one checkpoint and diffed; Nemotron explains
what moved and never decides severity. Submission for the Nebius × NVIDIA Global AI Hackathon.
Deadline **30 Oct 2026, 10:00 PT**. (The repository is still called `cassandra`, its first idea.)

## The one rule that decides the project

**Nothing is reported that was not watched, and nothing unwatched is called clean.**

- A version that did not install, or whose probe never reported, is refused by the index
  (`transcript/schema.js` `unobserved()`) and stays *unknown* — never "quiet".
- Severity comes from the differ's rules (`differ/diff.js`), in code. A model explains; it never
  escalates, and an accusation needs two model families to agree (`judge/`).
- A behaviour the runtime performs on a package's behalf (Node's own env reads and decodes) is not
  the package's (`observe/probe.js`, caller-frame rule).

If a change makes the report longer but the evidence thinner, it is the wrong change.

## Layout

| path | what belongs there |
|---|---|
| `observe/probe.js` | the runtime probe — import and install phase; `public/probe.source.txt` is its verbatim copy for the hosted bundle (a test keeps them equal) |
| `adapters/` | sandbox backends: `contree.js` (Nebius), `local.js`, `simulated.js` — one interface |
| `transcript/`, `differ/`, `judge/`, `evidence/` | what was seen, what changed, what a model makes of it, what the open web says |
| `index/`, `lock.js`, `lockfile.js`, `cli.js` | the behavioural index, `stakeout.lock`, and the CLI that checks a tree against it |
| `scripts/` | index builds (`index-build.js`), the release watch, cross-validation, summaries |
| `server.js`, `yours.js`, `github/` | the hosted site's API, the "try it on yours" routes, the GitHub App |
| `web/` → `dist/` | the site; `dist/` is committed on purpose (a server test reads it) |

## Conventions

- Node, no runtime dependencies. `npm test` runs every suite and checks the README's count.
- `npm run check-readme` — every figure the documents quote must be one a command still produces.
- `npm run smoke:live` after every deploy: the deployed bundle can break what the suite passes.
- Nebius Sandboxes allows 50 simultaneous instances — shared with the hosted `/api/watch`.
- Two sessions may share this checkout: commit only your own paths, and deploy from one place.

## Definition of done for any change

- `npm test` green, `check-readme` clean.
- After a deploy, `npm run smoke:live` green.
- A number in a document comes from a file a command writes — never typed.
