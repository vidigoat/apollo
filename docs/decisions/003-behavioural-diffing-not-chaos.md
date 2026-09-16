# 003 — Behavioural diffing, not chaos rehearsal

**Status:** Accepted. Reverses the project's original direction.

## What it was

The first version forked a live application many ways and rehearsed how it could break — a
pre-mortem engine. It worked, and it was the wrong product.

## Why it changed

Chaos harnesses exist. Gremlin, Chaos Mesh, Litmus, AWS FIS. Building a better one is a crowded
fight decided by integrations, and nothing about forking a checkpoint made our version meaningfully
different from theirs.

The question nobody answers is narrower and sharper: **your lockfile pins a version, but nothing
pins what that version does.** `2.1.0 → 2.1.1` is a string. Whether the new one started reading
`AWS_SECRET_ACCESS_KEY` is not visible anywhere in your toolchain.

That question needs exactly the capability chaos rehearsal needed — cheap, isolated, forked-from-one-
state execution — but it is unanswered, and answering it has a deadline attached. npm 12 disabled
install scripts in July 2026; six days later an attack moved to import time. Reading source is
behind; watching execution is not.

## What it cost

The scenario engine, its tests, and `orchestrator.js` were deleted rather than adapted. After the
pivot their tests had begun passing *vacuously* — asserting things about a code path nothing
reached — which is worse than having no tests, because it reports confidence that does not exist.

## What would change it

Evidence that developers will not run a tool that costs real money per install. The cost model is
the weakest part of the thesis; the technical claim is not.
