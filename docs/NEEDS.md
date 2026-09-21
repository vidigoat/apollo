# What is needed from Vidit — both projects, one list

Written 21 Sep 2026. Ordered by **what blocks the most work**, not by effort.

Copy of this file lives in `~/second-set-of-hands/docs/NEEDS.md`; they are kept identical.

```
Amazon   freeze 13–15 Oct   22–24 build days left
Nebius   freeze 20–22 Oct   29–31 build days left
```

---

## Tier 1 — blocking. These change what gets built.

### 1. Click "Request beta access" on the Sandboxes page  ⏱ 30 seconds

`tokenfactory.nebius.com/sandboxes/about` → the purple **Request beta access** button.

**This is now the single highest-value click available.** The page you screenshotted says, in
Nebius's own words:

> **Free while in beta — runs don't consume your credits.**

Which removes the one constraint that was capping the whole project. The behavioural index was
sized at 1,000 packages because sandbox time looked like it would eat $30 of credits. If compute is
free, the limit becomes wall-clock and the documented 50-concurrent cap — so the target goes to
**5,000 packages, stretch 20,000**, which is a genuine map of the part of npm that matters rather
than a survey.

Verified 21 Sep: the API still returns `404 Not Found` on every sandbox endpoint with a working
key, so access has **not** been granted yet. The button is the thing.

If it is still 404 in a week, the fallback is already designed — build the index with the local
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

**What they are for.** `npm run eval` scores the vision reader on nine *rendered* panels — images we
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

### 7. A GitHub App, or permission for me to create one  ⏱ 10 minutes, needed by ~13 Oct

The GitHub App is where Stakeout stops being a page and becomes a thing developers use: it comments
on your Dependabot PR with what the upgrade actually *does*.

Either create one yourself (Settings → Developer settings → GitHub Apps) and give me the App ID and
private key, **or** say "go ahead" and I will walk you through the three clicks when we get there.
It stays in development mode — no public listing, no review.

### 8. Two decisions  ⏱ one reply each

- **Does `~/cassandra` go public at submission?** Nebius *requires* it. MIT is already in place. I
  assume yes unless you say otherwise.
- **Does `~/second-set-of-hands` stay private?** Amazon allows private if shared with
  `testing@devpost.com` and `@AmazonAppDev`. I assume private unless you say otherwise.

### 9. Rotate the AWS key  ⏱ 5 minutes

IAM → user `bedrock-hackathon` → Security credentials → deactivate the old key, create a new one,
and I will update the profile. It has been pasted into chat twice.

Not urgent for the build. It is a real exposure and it should not go into December.

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
  1   click "Request beta access" on the Sandboxes page        ← the one that matters
  1b  re-try the $25 promo code (your balance reads $0.85)

done ✅  Tavily key · Vercel login · Builders Program · manual-download permission

not blocking — resolves during recording week
  2   appliance photographs

later, when I ask
  7   GitHub App  ·  8  two public/private decisions  ·  9  rotate the AWS key
```

Item 1 is the only thing left that changes what I build. Everything else I can start on today.
