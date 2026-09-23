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

---

### 2026-09-20 · A reasoning model can return an empty answer, successfully, and bill you

**What happened.** First live call to `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` came back with
`finish_reason: "stop"`, a valid `usage` block, and `message.content` as the empty string. No error,
no warning, a real charge. The pipeline read it as "the model declined to answer" and fell through
to its offline path.

The cause is that Nemotron 3 emits its working-out in `message.reasoning`, separately from
`message.content`, and **both are billed as completion tokens with reasoning spent first.** Our
`max_tokens` was sized for the answer, so the thinking consumed the whole allowance and the answer
had nowhere to go.

**Why it is worth reporting.** It is silent, it costs money, and it is invisible to anyone porting a
prompt from a non-reasoning model — which is most people arriving at Nemotron for the first time.
Nothing in the response distinguishes "the model chose to say nothing" from "the budget ran out
before it got to the answer". `finish_reason` says `stop` in both cases, which is the field you
would reach for.

**Suggestions, cheapest first:**

1. `finish_reason: "reasoning_exhausted"` — or anything other than `stop` — when the allowance is
   consumed before `content` begins. One string, and the failure becomes self-diagnosing.
2. Split the usage block: `completion_tokens_details.reasoning_tokens`, the way other providers
   already report it. We could not see where the money went.
3. One line in the model card: *"reasoning is charged as completion tokens and emitted before the
   answer; budget for both."* This is the single fact we most needed and had to derive from a bill.

**What it cost us:** roughly forty minutes and a wrong diagnosis. We first assumed a bad prompt,
then a bad model id, before dumping the raw response.

---

### 2026-09-20 · Model ids are not discoverable from the documentation

**What happened.** Three model ids were written from how the models are named in prose, and all
three 404'd:

```
nvidia/NVIDIA-Nemotron-3-Ultra-550B     ✗ does not exist
nvidia/Nemotron-3-Ultra-550b-a55b       ✓ actual
```

`GET /v1/models` gave the correct list immediately. The 404 body was genuinely helpful — it named
the model that did not exist rather than returning a generic error — and that is worth saying,
because it is the reason this took two minutes to fix rather than an afternoon.

**Why it is worth reporting.** The casing and the `-a55b`/`-a12b`/`-A3B` suffixes are not guessable,
and they vary *between* models in the same family: `Nano-30B-A3B` is capitalised, `super-120b-a12b`
is not. Anyone typing an id by hand gets it wrong, and if their code has a simulated fallback — ours
did — the failure looks like a deliberate offline mode rather than a typo.

**Suggestions:**

1. Put the exact, copyable id in the model card, adjacent to the display name. Ours were inferred
   from the display name and every one was wrong.
2. Normalise the casing across the family, or document that it is deliberate.

---

### 2026-09-20 · There is no per-key spend ceiling

**What happened.** An afternoon of screenshots put 145 model calls through one key, because a page
that re-judged on every load was refreshed a lot. Small money — under fifteen cents — but nothing
in the platform would have stopped it at any number.

**Why it is worth reporting.** Hackathon entrants are running on promotional credits with a
hard floor at zero, and many are building **hosted demos**, which is what the submission rules ask
for. A public URL that makes model calls per visitor is an unbounded spend authorised by a stranger
with a refresh key. We ended up writing our own on-disk ledger and pre-flight check to feel safe
publishing one.

**Suggestion:** a per-key monthly cap, settable in the console, that returns a distinct error code
when hit. Even a hard stop with no warning would be better than no ceiling, and for this audience it
is the difference between publishing a demo URL and not.

---

### 2026-09-23 · A week of 404s that were our URL — and a 404 is how "no access" looks too

**What happened.** For a week every Sandboxes call returned `404 Not Found`, with a key that worked
for chat completions. We read that as "access not granted yet" and waited. It was not access: the
base URL we had inferred was wrong, and we were not sending a `Project` header at all. Both came out
of reading the `contree-sdk` 0.3.6 source, not the docs — the REST surface is
`https://api.tokenfactory.nebius.com/sandboxes`, with `Authorization: Bearer <key>` **and**
`Project: <project id>` on every request.

Against the right URL the key authenticates, and `whoami` answers — with every permission false and
the limits stated (50 concurrent instances, 3,600 s each). The beta request has been submitted
through the page; nothing in the API or console says whether it is pending, refused, or granted.

**Why it is worth reporting.** Two opposite states — *you are calling the wrong thing* and *you are
calling the right thing without permission* — came back identical, so an entrant cannot tell a bug
in their own code from a queue they are sitting in. We sat in the wrong one for a week.

**It also answered our 15 Sep note.** The model is images and instances: a non-disposable run
produces a new image, and that image is the checkpoint — forking is running from the same image
twice. That is a clean primitive, and one sentence saying so in the README would have saved the
inference.

**Suggestions:**
1. Document the REST base URL and the `Project` header next to the SDK quickstart.
2. Answer an unpermitted call with `403` and a reason (`sandboxes beta access not granted for this
   project`), never `404` — keep 404 for paths that do not exist.
3. Show the beta request's status in the console, and in `whoami`.
