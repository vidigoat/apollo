# The thesis, sharpened into a primitive

The line has always been right. We have been treating it as a tagline when it should be a **file**.

```
package-lock.json    pins    express@4.18.3                        a version
apollo.lock        pins    express@4.18.3 reads no environment
                             variable, opens no socket, spawns
                             nothing, writes only inside node_modules   a behaviour
```

You commit `apollo.lock`. CI diffs against it. **A dependency that changes what it DOES fails your
build even when the version did not move** — which is precisely the 2024–26 supply-chain attack: a
compromised maintainer publishing a patch release that no diff and no changelog reveals.

Nobody has this primitive. It is the difference between a demo and a thing people adopt.

### Why this also solves scale

The expensive work is running a package. If we do that **once**, centrally, and publish the result,
then checking your hundredth repository is a *lookup* rather than a hundred sandbox runs.

```
                ┌───────────────────────────────────────────────┐
                │  THE INDEX                                    │
                │  behaviour(package, version, strategy)        │
                │  computed once, published as static JSON      │
                │  + a query API. Free for anyone.              │
                └───────────────────┬───────────────────────────┘
                                    │  lookup — not a run
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  apollo CLI               GitHub App and Actions        the site
  `apollo lock`            checks the versions a          check a lockfile,
  `apollo check`           pull request bumps             watch an upgrade,
  commit the lock, CI      against the record             read the live watch
  fails on drift
```

Three surfaces, one engine. The index is the moat; everything else is a thin client over it.
