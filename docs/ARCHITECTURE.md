# Architecture

`TODO` — expand each heading once the real adapter lands. Keep this file honest about seams.

## The seam that matters
`adapters/` is the only place that knows what a sandbox is. The engine asks for a checkpoint and for N
parallel branches; it must never learn ConTree specifics.

```
engine.js ──► SandboxAdapter
                 ├── simulated.js   fixed corpus, deterministic, no network
                 └── contree.js     Nebius Token Factory Sandboxes
```

## Adapter interface
| method | contract |
|---|---|
| `boot(image)` | returns a healthy checkpoint id |
| `fork(checkpoint, n)` | returns n branch handles, running in parallel |
| `run(branch, cmd)` | executes, returns exit code + real output |
| `discard(branch)` | releases it |

## Wave scheduling
Sandboxes caps simultaneous operations at 50, so 200 twins run as four waves. `TODO` — document backoff
and partial-wave handling.

## The three gates
`TODO` — reproduce-or-silent, independent verification, proof by re-forking. One section each, with the
function that implements it.
