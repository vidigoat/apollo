# 007 — The corpus contains packages we should miss

**Status:** Accepted.

## The decision

Three packages are planted in the corpus. Only one of them is something Stakeout should catch.

- **PLANTED-1** `express-fileupload@2.1.1` — credential read plus exfiltration at import time.
  *Should be caught.*
- **PLANTED-2** `money-fmt@2.4.2` — rounding changed from `HALF_EVEN` to `HALF_UP`. No new
  syscalls, no new hosts, no new files. *Should be missed, and the miss should be shown.*
- **PLANTED-3** `node-fetch-retry@2.2.0` — genuinely contacts a host it never contacted before,
  documented by the maintainer. *Should be noticed and not accused.*

## Why

A benchmark whose plants are all true positives can be won by flagging everything. Any tool that
alerts on every diff scores perfectly on it, and is useless in practice — the failure mode of most
supply-chain scanners is not blindness, it is noise.

Two of the three plants exist to make that cheat cost something.

PLANTED-3 is behaviourally *identical in kind* to PLANTED-1: new destination, contacted at import.
The only thing separating them is the public record. Any approach that flags on behaviour alone
fails this one, which is precisely why the evidence layer exists and is not decoration.

PLANTED-2 is the honest part. Watching behaviour cannot see a computation change, so the interface
has a section for it, the demo prints it, and the README says it in the second paragraph about
results. A tool that only advertises its hits is not a security tool.

## The rule that follows

Plants are labelled as plants — in `corpus.js`, in `corpus.test.js`, in the README, and on the page
itself. A detection you cannot reproduce is a magic trick.
