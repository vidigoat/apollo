# Deploying the demo URL

Nebius requires *"a working demo URL — hosted app or test build"*. This is that, in two commands.

```bash
npx vercel login
npx vercel --prod
```

No build step, no dependencies, no framework to configure. `vercel.json` routes everything to
`api/index.js`, which is the same `handler` `npm start` serves — not a second, subtly different copy,
because a demo URL showing something the repository does not do is worse than no demo URL.

## Set one environment variable, or none

| variable | effect |
|---|---|
| *(nothing)* | The page works. Verdicts come from `judge/verdicts/`, which is committed. Zero model calls, zero cost, `simulated: false` — they are real Nemotron verdicts, just not fetched live. |
| `NEBIUS_API_KEY` | Anything not already in the shipped verdicts is judged live. Only matters if you change the corpus. |

**Leaving the key off is a defensible choice, and possibly the right one.** The shipped verdicts are
real, and they are reviewable: they are JSON in the repository, so anyone can open the diff and read
exactly what the models said rather than taking a screenshot's word for it.

## What the hosted version deliberately cannot do

`/api/real` — running actual npm packages — stays behind `STAKEOUT_ALLOW_LOCAL`, which is never set
here, and returns a 403 explaining why. Executing strangers' packages on shared infrastructure would
be the precise thing this project warns about, performed by this project.

## Why it will not bill you per visitor

This was a real bug, found by watching the ledger climb to 145 calls in an afternoon of taking
screenshots. Every page load re-judged all fifteen packages. On a public URL, a judge refreshing ten
times would have paid for ninety Nemotron calls to be told the same thing ten times.

Verdicts are now cached, and the cache is **committed** (`judge/verdicts/`, 16 kB) rather than living
under `$HOME` — because a serverless filesystem is ephemeral and read-only, so a home-directory cache
does not survive a cold start and every visitor would arrive to an empty one.

Verified by pointing the local cache at a directory that does not exist:

```
5 of 5 verdicts served from the committed set, 0 model calls
```

`vercel.json` carries `includeFiles: judge/verdicts/**`, because Vercel traces a function's imports
and would not otherwise ship files that are only ever read at runtime by path.

## After deploying

```bash
curl -s https://<your-url>/api/run | head -c 200     # should return the run, not an error
```

Then put the URL in the Devpost submission, and in `docs/SUBMISSION.md` next to the demo-URL row.

## Stakeout Live, always on — Nebius Serverless Jobs

The npm watcher (`scripts/firehose.js`) runs until the deadline as a chain of week-long Serverless
Jobs. A job's disk dies with it, so the watch's state is mirrored to Nebius Object Storage
(`firehose/mirror.js`) and each new job restores it before its first poll: it continues the same
watch from the saved feed position, and nothing published between two jobs is missed.

```
bash deploy/nebius/launch.sh             # once: registry, bucket, key, secret, image, first job
bash deploy/nebius/launch.sh --health    # alive, and keeping up with npm?
bash deploy/nebius/launch.sh --relaunch  # each week, after the last job ends (refused while one is alive)
```

- **Cost:** one `cpu-e2` `2vcpu-8gb` VM, $0.05–0.06/h — about $1.40 a day. The sandboxes it
  uses are Token Factory Sandboxes, free in beta. The script shows this and asks before starting.
- **Inside the job:** `scripts/firehose-supervise.js` restarts a watcher that dies (5 s, doubling
  to 5 min); the watcher writes `heartbeat.json` every poll; `scripts/firehose-health.js` calls it
  unhealthy when the heartbeat is 10 minutes old, it is 20,000 changes behind npm, or a due release
  has waited an hour.
- **Keys:** NEBIUS_API_KEY, NEBIUS_PROJECT_ID and the bucket's S3 key live in MysteryBox and reach
  the job as `--env-secret`. The image carries none (`.dockerignore` is an allow-list without `.env`).
- **Rehearsed without Nebius:** the image run locally against real Sandboxes; and two containers
  in a row against a local object store — the second started on an empty disk, restored the
  watch, and resumed at the first one's position with the first one's start time.
- **Not yet run against a real Nebius account.** The first launch is where a flag the docs did not
  show would surface; `--health` five minutes later is the check.
