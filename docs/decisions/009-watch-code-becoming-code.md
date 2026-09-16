# 009 — Watch a string turning into a function

**Status:** Accepted.

## The decision

A sixth channel, `exec`, recording the mechanisms by which code comes into existence at runtime:
the `Function` constructor, `vm.runInNewContext` and its siblings, and large base64 decodes. Only
the `nodert` strategy claims it.

## Why

2026's attacks do not ship a payload. They ship a decoder.

That matters more than it sounds, because a string becoming executable **is not a syscall**. It is
one process rearranging its own memory. eBPF watches what a process asks the kernel for, and this
never reaches the kernel — so a kernel tracer sees the socket that opens afterwards, and nothing
whatsoever that explains it. By the time anything is observable, the interesting part has happened.

PLANTED-4 in the corpus exists to make this concrete. Read three ways:

```
fsdiff   NONE      nothing observed          (cannot see: net, dns, env, proc, exec)
ebpf     NOTABLE   talks to 1 destination    (cannot see: exec)
nodert   ALARMING  builds and runs code that did not exist in the source
```

Same package. Same bytes. Three honest answers.

## The consequence worth stating

`nodert` is weaker than eBPF nearly everywhere — a native addon, a WebAssembly module, or code that
captured a reference before the probe loaded all go underneath it — and stronger in exactly one
place. That is the argument for keeping it as a strategy rather than treating it as a stopgap until
Sandboxes access arrives. There is no single best observer, only observers with different blind
spots, which is why every transcript carries the one that produced it.

## Where the line is drawn

Building code is alarming. **Decoding is not.** Half the registry decodes something, and what
matters is what the decoding feeds — so a base64 decode on its own is `minor`: still a change, still
named, nobody woken. Only `Function` and `vm.*` escalate.

And the rule that governs everything here still governs this: a package that *always* built code at
runtime is not a finding. This compares you to your previous version, not to "good".

## What it cost, and what it exposed

Adding a channel meant editing four hard-coded lists — the simulated adapter, the ConTree adapter,
the observer's accumulator, and its copy loop — each of which silently dropped the new field on the
way through. The symptom was `nodert` reporting `notable`: a strategy that could see the
construction, reporting only the socket. That a sixth channel required finding four hard-coded
fives is worth remembering next time one is added.

It also exposed a real flaw one level up. A transcript was recording `exec` even under a strategy
that explicitly declares it cannot see it, so the data and the caveat could disagree, and the differ
could raise a finding out of an observation that never happened. `transcript()` now drops any
channel its strategy cannot see — the `canSee` contract is structural rather than advisory. Same
bug as reporting an unwatched run as a quiet one (005), one level further in.
