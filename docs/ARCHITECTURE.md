# Architecture

Data flows one way, and each stage is allowed to do strictly less than the one before it.

```
  package-lock.json ─┐
  or the fixture     │
                     ▼
            ┌─────────────────┐
            │   runPair.js    │   fork TWO twins from ONE checkpoint, same instant
            └────────┬────────┘   release both in a finally, always
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   observe/index.js          observe/index.js     install, then import
        │                         │               (import is where 2026's attacks fire)
        ▼                         ▼
  transcript/schema.js      transcript/schema.js  normalise; DROP any channel this
        │                         │               strategy declared it cannot see
        └────────────┬────────────┘
                     ▼
              differ/diff.js      arithmetic. severity. no model involved.
                     │
                     ▼
              judge/index.js      Nemotron: Nano triage → Ultra judgement → Super veto
                     │            may explain, may de-escalate, may NEVER escalate
                     ▼
            evidence/tavily.js    does the open web know about this?
                     │
                     ▼
              a finding, or silence
```

## The three boundaries that hold it up

Each is enforced structurally — by there being nowhere else — and `architecture.test.js` fails if
that stops being true. They are the reason the project's claims are checkable rather than asserted.

### 1. One checkpoint, or the comparison means nothing

If the two versions ran on two separately-booted machines, any difference could be the *machine*: a
different DNS cache, a different clock, a different temp directory. The whole claim is attribution —
that the difference is the package — so both twins fork from a single snapshot at the same instant.

`runPair.test.js` wraps `adapter.fork`, records every checkpoint the twins came from, and fails if
there is more than one. `architecture.test.js` fails if anything but `runPair` forks a pair, because
for a while four other paths had their own copy of that sequence and the tested guarantee did not
cover the shipping code.

### 2. A transcript cannot contain what its strategy could not see

`canSee` was advisory once, and the data and the caveat could therefore disagree — which would let
the differ raise a finding out of an observation that never happened. `transcript()` now drops any
channel the strategy declared itself blind to, so the two can no longer differ.

This is why the same package reads three ways, honestly:

```
fsdiff   NONE      nothing observed          (cannot see: net, dns, env, proc, exec)
ebpf     NOTABLE   talks to 1 destination    (cannot see: exec)
nodert   ALARMING  builds and runs code that did not exist in the source
```

### 3. Rules escalate. Models explain.

Severity comes from about thirty lines of arithmetic in `differ/diff.js`. A model may say what a
change appears to be *doing*, and may talk a finding **down** — "the changelog documents this
endpoint". It can never talk one **up**.

Not philosophy. This tool's output is an accusation against a named person's package, so the
ceiling on severity has to be something anyone can read in one sitting and argue with. It also
turned a *successful* prompt injection into a non-event: the model was talked out of the finding and
the package stayed `alarming` anyway, because the model was never able to set that.

## The adapter seam

`adapters/` is the only place that knows what a sandbox is.

| method | contract |
|---|---|
| `boot(image)` | a healthy checkpoint, made exactly once per run |
| `fork(checkpoint, n)` | n branches, all from that one checkpoint |
| `run(branch, cmd, ctx)` | executes; `observed` is `null` when nothing watched, `{}` when nothing happened |
| `discard(branch)` | releases it |
| `supports` | which strategies this account's guests actually permit |

Three implementations, and the differences between them are the honest part:

- **`simulated.js`** — a fixed corpus, no network. Deterministic, which is what makes the demo
  checkable by a stranger.
- **`local.js`** — real `npm install` into throwaway directories on this machine, watched by
  `observe/probe.js`. The only adapter that has actually run. Requires `STAKEOUT_ALLOW_LOCAL=1`,
  because it executes packages as *you*.
- **`contree.js`** — Nebius Sandboxes. Written and tested against a stub; has never talked to a live
  sandbox. Every call goes through one `api()` helper so there is exactly one place to correct.

`supports` defaults to the weakest option in every adapter. Claiming a strategy you do not have
turns *"we could not see it"* into *"nothing happened"*, which is the one lie this project cannot
afford.

## Wave scheduling

Sandboxes caps simultaneous operations at 50, so pairs run in waves of 25 packages. `runPair.test.js`
asserts peak concurrency never exceeds the cap and that every branch is released when a wave
finishes — including when a run throws halfway through, which is the case a hand-rolled version
forgets first.

## The cache

`cache.js` keys on `pkg@from→to` **plus the strategy and the schema version**. A run watched with
`fsdiff` and one watched with `nodert` are different questions, and serving one for the other would
resurrect boundary 2 through the back door. Only the behavioural diff is cached — never the model's
judgement, which depends on a prompt that changes, and never the public record, which is the one
input that legitimately changes over time.
