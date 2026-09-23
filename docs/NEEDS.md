# What is needed from Vidit — both projects, one list

Written 21 Sep 2026, revised 23 Sep (twice). Ordered by **what blocks the most work**, not by effort.

Copy of this file lives in `~/second-set-of-hands/docs/NEEDS.md`; they are kept identical.

```
Amazon   freeze 13–15 Oct   22–24 build days left
Nebius   freeze 20–22 Oct   29–31 build days left
```

---

## Tier 1 — blocking. These change what gets built.

### 1. ~~Click "Request beta access" on the Sandboxes page~~ ✅ GRANTED 23 Sep, 13:13

Live and used the same hour: `npm run preflight` passes 10 of 10 including a real package observed
in a real microVM; `npm run real -- --nebius` runs real pairs there; `index-build --nebius` grows the
index there, 40 at a time; and 299 of 300 re-observations matched the local ones on every channel (the one that did not had failed to install locally).

The original note, kept for the record:

`tokenfactory.nebius.com/sandboxes/about` → the purple **Request beta access** button.

**This is now the single highest-value click available.** The page you screenshotted says, in
Nebius's own words:

> **Free while in beta — runs don't consume your credits.**

Which removes the one constraint that was capping the whole project. The behavioural index was
sized at 1,000 packages because sandbox time looked like it would eat $30 of credits. If compute is
free, the limit becomes wall-clock and the documented 50-concurrent cap — so the target goes to
**5,000 packages, stretch 20,000**, which is a genuine map of the part of npm that matters rather
than a survey.

Verified 23 Sep: the week of `404 Not Found` was our own guessed URL and a missing `Project` header.
Against the real API (`api.tokenfactory.nebius.com/sandboxes`) the key **authenticates** — and
`whoami` reports every permission off, 50 concurrent / 3,600 s limits. So access has **not** been
granted yet, and the adapter needs no change once it is. The button is the thing.

If it is still ungranted in a week, the fallback is already designed — build the index with the local
`nodert` strategy, which really runs real packages, and record the strategy per entry so the weaker
claim is stated rather than hidden. Not fatal, just smaller.

---

### 1b. The $25 promo never applied  ⏱ 5 minutes

Your console reads **`Trial: $0.85 · 25 days`**. That is the original $1 trial minus the $0.14 we
have spent — so the `NEBIUS-DEVPOST-GLOBAL26` code did not land.

Re-try: https://nebius.com/promo-code?utm_promo_event_code=2026-devpost-global-ai-hack&utm_promo_code_type=Token_Factory&utm_promo_activation_code=NEBIUS-DEVPOST-GLOBAL26

**Not urgent.** Sandboxes are free in beta, and model calls are pennies — $0.85 still buys about
48 more full demo runs, and cached verdicts cost nothing. But it is free money and it takes a
minute.

---

### 2. Appliance photographs — **not blocking, and it solves itself**

You said you cannot do these right now. That is genuinely fine, and here is the honest accounting
so it is not carried as guilt.

**What they are for.** `npm run eval` — in `second-set-of-hands`, not here; this file is kept
identical in both repositories — scores the vision reader on nine *rendered* panels — images we
generated: a specular highlight across the digits, a crouching angle, an unlit utility room, a thumb
across a corner. It gets **7/9 fault codes, 1/1 model numbers, 0 invented codes**, and the two
misses return `null` rather than a guess, which is the failure mode this product needs.

But a rendered panel is a picture we drew. A real one has a segment LCD that blooms, a plastic
fascia that reflects a ceiling light, dust, and a phone camera's aggressive sharpening. **We do not
know how it performs on those, and the eval says so in its own output** — it prints `UNPROVEN` and
refuses to average the render score into a claim about real machines.

**Why it is not blocking.**

1. **The demo video is the proof.** When you record, you will point a real camera at a real machine
   and it will read a real code. That IS the evidence, and it is stronger than a test score because
   a judge watches it happen.
2. **It resolves at recording time for free.** While recording you will naturally capture frames of
   real panels. Those frames *become* the eval set — so the measurement arrives as a by-product of
   work you are doing anyway, around 13–15 Oct.
3. **The honest version already scores well.** Reporting "7/9 on hard rendered panels, real
   photographs pending" is a defensible, and frankly unusual, thing for a hackathon entry to say.
   Most claim more with less.

**So: do nothing now.** If you happen to pass a beeping dishwasher, take one photo. Otherwise this
gets picked up during the recording week, and I will keep the eval honest about it until then.

### 3. ~~Bulk manual downloads~~ ✅ GRANTED 21 Sep

Under 100 MB each, never GB-sized. Manufacturers' own public support pages; we extract the
fault-table page, derive the graph, cite the manual, and never redistribute the PDF.

---

## Tier 2 — done

### 4. ~~Tavily API key~~ ✅ DONE 21 Sep
Supplied and **verified live** — a real call returned a real advisory, `simulated: false`. That is
the entire criterion for the **$3,000 Best Use of Tavily** prize.

### 5. ~~Vercel login~~ ✅ DONE 21 Sep
Deploy is two commands whenever we want it. See `DEPLOY.md`.

### 6. ~~Builders Program~~ ✅ APPLIED 21 Sep
Credits arrive later. Not on the critical path now that sandboxes are free in beta.

---

## Tier 3 — needed before the relevant phase, not today

### 7. ~~A GitHub App~~ ✅ DONE — registered, deployed, verified live

Registered through the manifest flow, its key and secret pushed to the production environment, and
the webhook answering on the demo URL. Checked against it since: an unsigned delivery, a wrong
signature, a malformed one and a right-length-wrong-algorithm one all answer 401. Nothing gets
through without the secret.

`npm run check-run` prints all three check runs it posts, through the real handler, with no GitHub
account needed.

### 7b. ~~Deploy the two demo URLs~~ ✅ DONE — both live and public

Both are ready. `npx vercel --prod` in each repo — no build step, no framework config, no
environment variables required. `DEPLOY.md` in each says what the hosted version deliberately cannot
do and what it says instead.

Both are live:

- **<https://cassandra-nu.vercel.app>** — and it now serves the **published index** at
  `/index.json`: 5,691 packages, about 370 kB over the wire. A stranger can point `cli.js lock --index` at
  it and get their own tree answered without building anything, which is the part of the argument
  that used to be unverifiable.
- **<https://second-set-of-hands.vercel.app>** — and `/review.html` now **reads a manual you drop
  on it**. That used to need `pdftotext`, which the host does not have; the reader is written here
  now with no dependencies, so the one capability the project is for is finally reachable from the
  URL. Measured against poppler on 1,881 pages: identical page counts, 98.4–100% of its words,
  87.5% of its parsed rows word for word.

Two things that were true when this was written and still are:

- `~/cassandra` carries a real committed scan of a checkout of vercel/turborepo, so the hosted fleet
  page has measured numbers where there is no filesystem to read — and it says whose tree it is
  rather than letting it read as yours.
- `~/second-set-of-hands` still shows an **empty review queue** when hosted: the queue is the
  manuals *you* fetched and it is gitignored on purpose. The drop target underneath it is the way
  in now, and the bench says which of the two you are looking at.

### 8. Two decisions  ⏱ one reply each

- **Does `~/cassandra` go public at submission?** Nebius *requires* it. MIT is already in place. I
  assume yes unless you say otherwise.
- **Does `~/second-set-of-hands` stay private?** Amazon allows private if shared with
  `testing@devpost.com` and `@AmazonAppDev`. I assume private unless you say otherwise.

### 9. Rotate the AWS key  ⏱ 5 minutes

IAM → user `bedrock-hackathon` → Security credentials → deactivate the old key, create a new one,
and I will update the profile. It has been pasted into chat twice.

Not urgent for the build. It is a real exposure and it should not go into December.

### 10. Three new decisions, 23 Sep  ⏱ one reply each

- **AWS credentials on Vercel for the hosted `/talk.html`?** Then a judge can talk to the agent on
  the demo URL instead of watching the footage (`docs/media/talk.webm`). The global cap is now
  built: `mcp/shared-budget.js` keeps the ledger as one DynamoDB item that every instance reserves
  against in a single conditional write — two instances racing for the last cent cannot both get
  it (tested), an unreachable ledger stops the call, and a deployment with keys but no ledger
  refuses to talk. Signing verified against the real DynamoDB endpoint. Turning it on is one
  command, which shows what it will do and asks before touching anything:
  `AWS_PROFILE=<admin profile> bash ~/second-set-of-hands/scripts/hosted-setup.sh` — a separate
  IAM user that can only call Nova 2 Lite and touch that one table, a free-tier table, keys piped
  into Vercel unprinted, $5 ceiling for everything together. `--undo` takes it all away.
- **Grow Stakeout's index on your Mac?** Done — in Colima containers that see only
  `~/stakeout-index-work`, then on Nebius once Sandboxes opened: 12,281 versions, every one of
  them observed on Nebius by now.
- **A Tavily key on Vercel?** Optional. The hosted run's corpus is planted packages, so a live search
  would only confirm they are unmentioned; and the Tavily prize cannot be won alongside the Overall.

---

## Not needed, explicitly

So you do not spend time on them:

- **A domain.** A `vercel.app` URL is fine for both. If you happen to own something suitable, say
  so; do not buy one.
- **AgentCore access.** Refused by the current IAM identity, and the memory layer is ours already.
  It is a "what's next" line.
- **The $500 City Winner award.** Geographic eligibility only, and the twenty cities are all in
  Europe, North America and East Asia. Not reachable.
- **Any design assets.** Brand logos come from official press kits, under their published usage
  rules. Nothing gets redrawn by hand.

---

## The shortest version

```
right now — 6 minutes, and one of them is 30 seconds
  1   ✅ Sandboxes beta access — granted 23 Sep, live and in use
  1b  re-try the $25 promo code (your balance reads $0.85)

done ✅  Tavily key · Vercel login · Builders Program · manual-download permission
        GitHub App (registered, deployed, live) · both demo URLs (live and public)

not blocking — resolves during recording week
  2   appliance photographs



still yours to decide
  8   ~/cassandra goes PUBLIC at submission — Nebius requires it, and it is private today
      ~/second-set-of-hands may stay private if shared with testing@devpost.com and @AmazonAppDev
  9   rotate the AWS key
  10  hosted agent: run scripts/hosted-setup.sh ($5 global cap, built and tested) · Tavily on Vercel (optional)

  one thing worth knowing before 8: the git history of ~/cassandra contains an old screenshot of
  a scan of YOUR home directory — repository names, from before that image was replaced. Private
  today. Making the repo public makes that history public with it.
```

Item 1 is still the only thing left that changes what I build.
