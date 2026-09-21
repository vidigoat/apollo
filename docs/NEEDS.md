# What is needed from Vidit — both projects, one list

Written 21 Sep 2026. Ordered by **what blocks the most work**, not by effort.

Copy of this file lives in `~/second-set-of-hands/docs/NEEDS.md`; they are kept identical.

```
Amazon   freeze 13–15 Oct   22–24 build days left
Nebius   freeze 20–22 Oct   29–31 build days left
```

---

## Tier 1 — blocking. These change what gets built.

### 1. Nebius Sandboxes: is it coming or not?  ⏱ 2 minutes

Click **Sandboxes** in the Nebius console sidebar and tell me exactly what it says — a waitlist
form, a "request access" button, a price, or nothing at all. If there is a waitlist, join it.

**Why it is first:** confirmed `404 Not Found` on 20 Sep *with a working key*, so this is access,
not configuration. The answer decides whether the index is built on kernel-level sandboxes or on
the local `nodert` strategy. Both work; they produce different claims, and the plan branches here.

**If the answer is "no" or "silence for two weeks", nothing is lost** — the fallback is already
designed and the index records which strategy observed each entry, so nothing overclaims.

---

### 2. Appliance photographs — 6 to 10  ⏱ 15 minutes

Into `~/second-set-of-hands/eval/photos/`. Phone camera is fine, no editing.

```
what to shoot                                        why
─────────────────────────────────────────────────────────────────────────────
a lit error code on any appliance panel              the core read
the rating plate inside a door (model + serial)      the second read
one in a dim room, no flash                          the failure case we claim to handle
one at a kneeling angle, not square-on               the real posture
one with a thumb or reflection across the corner     the hard case
a machine with NO fault showing                      it must not invent one
```

**Why:** `npm run eval` currently scores 7/9 on *rendered* panels and says, in its own output, that
the claim to read real machines is **UNPROVEN**. Six photographs turn the strongest measured result
in that project from a claim into a measurement. It is the single highest-value thing you can hand
over and it takes a quarter of an hour.

Neighbours' and family's machines count. More brands is better than more photos of one machine.

---

### 3. Permission: may I download manufacturer service manuals in bulk?  ⏱ one reply

The machine library — 150–200 appliances instead of 1 — is the biggest single lever on the Amazon
submission, and the bottleneck is sourcing PDFs, not code.

**What I would do:** download manuals from manufacturers' own public support pages (Bosch, Miele,
LG, Samsung, Whirlpool, Siemens, Hotpoint, Beko), extract only the fault-table page, derive the
fault graph, and **cite** the manual. We would not redistribute anybody's PDF — every cause already
carries `source: { line, manual }` so a reader checks it against their own copy.

**Just reply yes or no.** If no, tell me how you would rather source them and I will build to that
instead.

---

## Tier 2 — unblocks a whole surface

### 4. Tavily API key  ⏱ 5 minutes

Free tier. → `~/cassandra/.env` as `TAVILY_API_KEY=...` (the file, not chat).

**Why:** the **$3,000 Best Use of Tavily** prize is judged on one thing — *"a functional, runtime
call to the Tavily API"*. Not a creativity contest. The code is already written
(`evidence/tavily.js`) and falls back to a recorded corpus without a key. This is the best
money-per-minute item in either hackathon.

### 5. Vercel login  ⏱ 3 minutes

Run `npx vercel login` in `~/cassandra` and tell me when it is done. I will deploy.

**Why:** Nebius **requires** a working demo URL. It is already safe to publish — verdicts ship
committed, so a visitor costs $0.00 and a cold start makes zero model calls. `DEPLOY.md` has the
detail.

### 6. The second $25 of Nebius credits  ⏱ 5 minutes

https://dev.nebius.com/builders — the Builders Program. You already did the first $25 via the
promo code.

**Why:** the index costs roughly $15–30 of sandbox time at 500–1,000 packages. $50 makes 1,000
comfortable; $25 caps us around 300. The Builders Program is also where the Tavily credits come
from, so item 4 may arrive with it.

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
today, 25 minutes total
  1  click Sandboxes, tell me what it says
  2  take 6 appliance photos → second-set-of-hands/eval/photos/
  3  reply yes/no on bulk manual downloads
  4  Tavily key → cassandra/.env
  5  npx vercel login in cassandra
  6  join dev.nebius.com/builders

later, when I ask
  7  GitHub App
  8  two public/private decisions
  9  rotate the AWS key
```

Items 1–3 are the ones that change what I build. Everything else is plumbing I can work around.
