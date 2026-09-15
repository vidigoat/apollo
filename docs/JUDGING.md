# For reviewers

Four criteria, equally weighted. This is where each one is answered, and what is honestly not there
yet. Nothing below asks you to take a claim on trust — every row points at something you can run.

## Technological implementation
*How well is it built, and how effectively does it use Token Factory and an NVIDIA open model?*

| what to look at | where |
|---|---|
| The run: boot a checkpoint, fork it in waves, let each twin's probe decide | `orchestrator.js` → `runPremortem()` |
| The seam that makes the sandbox swappable | `adapters/` — `simulated.js` today, `contree.js` next |
| Wave cap respected, every branch released | `orchestrator.test.js` — "never forks more than the wave cap", "releases every branch it forks" |
| Scenario families and their injectors, addable without touching the engine | `scenarios/index.js` |
| Run it | `npm start`, then `GET /api/run` |

**Not there yet:** the ConTree adapter, and scenario authorship by Nemotron. `writeScenarios()` returns
the final shape so the orchestrator is already written against it.

## Design
*Does it deliver a complete product experience, not a proof of concept?*

| what to look at | where |
|---|---|
| The contact sheet — 200 twins, the failures circled like an editor's selects | `/` on localhost:8791 |
| A circled frame opens the case it produced | click any circled frame |
| The evidence panel: repro log, root cause, fix, proof | open a filed case |
| The refusal, driven by a real single sighting | the "refused to file" card |

## Potential impact
*Does it make a credible case for a real audience?*

An hour of downtime runs to roughly $300,000 for a mid-size enterprise. The three failures in the demo
corpus each mirror a documented 2025–26 incident class: a dependency change that corrupts data
silently, a race that duplicates a side effect, and a retry storm that turns a short dependency outage
into a long one. The shipping shape is a CI gate that comments on a pull request with the ways that
change takes production down.

## Quality of the idea
*Is this a creative, non-obvious use of the platform?*

Most uses of forkable sandboxes point at repairing code — an agent patches until tests pass. This
points the same primitive the other way: it *causes* failures in disposable twins to find the ones
that would have happened to you. Reproduction is what separates it from chaos tooling, which injects
from a fixed fault library and reports what it tried rather than what it proved.

The argument the project is really making is in `docs/decisions/001` and `002`: nothing is reported
that did not reproduce, and nothing on screen is written prose standing in for a result.
