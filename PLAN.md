# Plan

Nebius × NVIDIA Global AI Hackathon. Submissions close **30 Oct 2026, 10:00 PT** (30 Oct, 22:30 IST).
Judging 1–15 Dec. Winners ~11 Jan 2027.

Target: **$20,000 grand prize** (awarded across all tracks) plus the **$3,000 Tavily** bonus. A project
may win one overall award and one bonus award, so $23,000 is the ceiling for this entry.

## Runway

| week | what has to be true by the end of it |
|---|---|
| 0 · to 21 Sep | accounts live, credits claimed, **one real ConTree fork runs** — this is the go/no-go |
| 1 · 22–28 Sep | base image boots to a healthy checkpoint; N branches fork and run in parallel; real logs come back |
| 2 · 29 Sep–5 Oct | Nemotron writes scenarios from a real repo; Tavily seeds them; the verify gate refuses something |
| 3 · 6–12 Oct | proof loop (re-fork until green), pinned regression test, the report |
| 4 · 13–19 Oct | interface polish against real runs; README written; feedback drafted |
| 5 · 20–28 Oct | video recorded, submission filled, **submit 28 Oct** with two days of slack |

Amazon's deadline lands first (24 Oct), so weeks 1–4 here run second to that project. This one gets the
full run of 22–28 Oct.

## The go/no-go

If a real fork has not run by **26 Sep**, this entry is at risk and we decide then whether to continue
or fold the effort into the Amazon submission. The known failure mode is Token Factory billing
activation — other entrants hit country-level blocks on the forum, so it is cleared first, not last.

## Submission checklist

- [ ] Runtime call to Nebius Token Factory, and at least one NVIDIA open model
- [ ] Public repository, MIT licence visible on the repo page
- [ ] README with setup steps that actually work from a clean clone
- [ ] Working demo URL, reachable **through 15 Dec** — do not take it down in November
- [ ] Video under three minutes, public on YouTube, narration naming Token Factory and the Nemotron model
- [ ] Track selected, project description written
- [ ] Feedback on Nebius and NVIDIA tooling
- [ ] Tavily called at runtime, for the bonus

## What "done" means here

Not "it runs." A reviewer should be able to watch a wall of twins break, open one, read the log that
proves it, see the fix go green five hundred times, and see the one case the system refused to file.
If any of those four is missing, the entry is incomplete regardless of how much code exists.
