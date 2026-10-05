#!/usr/bin/env bash
# Apollo Live on Nebius: the npm watcher as a Serverless Job, its state in Object Storage.
#
#   bash deploy/nebius/launch.sh             # first time: registry, bucket, keys, secret, image, job
#   bash deploy/nebius/launch.sh --relaunch  # every week: a new 167 h job that resumes the watch
#   bash deploy/nebius/launch.sh --health    # is it alive and keeping up (reads the mirrored heartbeat)
#
# Needs: the `nebius` CLI, logged in (`nebius profile create`), docker, the AWS CLI (for S3), jq.
# Asks before anything that costs money, and says what it will cost.
#
# What it costs: one cpu-e2 2vcpu-8gb VM, $0.05/h ($0.06/h from 1 Oct) ≈ $1.40 a day, ≈ $45 to
# 30 Oct; a 30 GiB disk; object storage for a few MB. The sandboxes the watcher uses are Token
# Factory Sandboxes, free while in beta.
#
# Written against docs.nebius.com (26 Sep 2026) and not yet run against a real account — the
# first run is where a flag name or a selector format that the docs did not show would surface.
# Every step prints what it did, and --health after launch is the check that it worked.
set -euo pipefail
cd "$(dirname "$0")/../.."

REGION=eu-north1
NAME=apollo-live
BUCKET="${APOLLO_BUCKET:-stakeout-live-watch}"
PREFIX=live
ENDPOINT="https://storage.$REGION.nebius.cloud"
STATE_FILE=deploy/nebius/.launch-state   # ids of what this script made; gitignored, no secrets in it

# The CLI installs to ~/.nebius/bin; found there without anybody's shell profile having to change.
[[ -x "$HOME/.nebius/bin/nebius" ]] && PATH="$HOME/.nebius/bin:$PATH"

say() { printf '  %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { say "needs \`$1\` — $2"; exit 1; }; }
need nebius "install: https://docs.nebius.com/cli/install, then \`nebius profile create\`"
need docker "Docker Desktop or colima"
need aws "the AWS CLI, used here only as an S3 client for Nebius Object Storage"
need jq "brew install jq"
touch "$STATE_FILE"; source "$STATE_FILE"

if [[ "${1:-}" == "--health" ]]; then
  : "${S3_KEY_ID:?no launch state — run the first-time launch first}"
  APOLLO_STATE_S3="s3://$BUCKET/$PREFIX" APOLLO_S3_KEY_ID="$S3_KEY_ID" APOLLO_S3_SECRET="$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret')" \
    node scripts/firehose-health.js --mirror
  exit $?
fi

cat <<EOF

  This will, in the Nebius project of your current CLI profile ($(nebius profile current 2>/dev/null || echo '?')):
$( [[ "${1:-}" == "--relaunch" ]] && echo "    - start ONE new Serverless Job ($NAME), cpu-e2 2vcpu-8gb, 167 h, resuming the mirrored watch" || cat <<EOT
    - create a container registry and push the watcher image (81 MB)
    - create bucket $BUCKET, a service account with an S3 key for it, and a MysteryBox secret
      holding NEBIUS_API_KEY, NEBIUS_PROJECT_ID and that S3 key
    - start a Serverless Job ($NAME): cpu-e2 2vcpu-8gb, 30 GiB disk, restart on failure, 167 h
EOT
)
  Cost: about \$1.40 a day while the job runs (cpu-e2 at \$0.05–0.06/h). Stop it any time in the
  console, or let it end after 167 h.

  Note: the docs grant the service account storage access through the tenant's "editors" group,
  which is broader than one bucket. Tighten it in IAM if the project holds anything else.

EOF
# Two watchers on one mirror would be two writers of one state: a relaunch is refused while the
# mirrored heartbeat is fresh. Relaunch after the previous job has ended — the gap is caught up
# from the saved feed position, so nothing published in it is missed.
if [[ "${1:-}" == "--relaunch" && -n "${S3_KEY_ID:-}" ]]; then
  if bash "$0" --health >/dev/null 2>&1; then say "a watcher is alive on this mirror (heartbeat is fresh) — not starting a second one"; exit 1; fi
fi

read -r -p "  Go ahead? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { say "Nothing changed."; exit 1; }

if [[ "${1:-}" != "--relaunch" ]]; then
  # 1. The image, in Nebius Container Registry.
  if [[ -z "${REGISTRY_ID:-}" ]]; then
    REGISTRY_ID=$(nebius registry create --name "$NAME" --format json | jq -r '.metadata.id')
    echo "REGISTRY_ID=$REGISTRY_ID" >> "$STATE_FILE"
  fi
  nebius registry configure-helper >/dev/null
  # The registry path is the id without its "registry-" prefix (verify on the first run: if the push is
  # refused, the full id is the path).
  IMAGE="cr.$REGION.nebius.cloud/${REGISTRY_ID#registry-}/$NAME:$(git rev-parse --short HEAD)"
  docker build -q -f deploy/nebius/Dockerfile -t "$IMAGE" . >/dev/null
  docker push -q "$IMAGE" >/dev/null
  echo "IMAGE=$IMAGE" >> "$STATE_FILE"
  say "image  $IMAGE"

  # 2. Where the watch keeps its state between jobs.
  if [[ -z "${SA_ID:-}" ]]; then
    SA_ID=$(nebius iam service-account create --name "$NAME-state" --format jsonpath='{.metadata.id}')
    echo "SA_ID=$SA_ID" >> "$STATE_FILE"
    say "service account $SA_ID — add it to the editors group (IAM → Groups) if the next step is refused"
  fi
  if [[ -z "${ACCESS_KEY_ID:-}" ]]; then
    ACCESS_KEY_ID=$(nebius iam v2 access-key create --account-service-account-id "$SA_ID" --description "$NAME state mirror" --format json | jq -r '.metadata.id')
    echo "ACCESS_KEY_ID=$ACCESS_KEY_ID" >> "$STATE_FILE"
  fi
  S3_KEY_ID=$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.aws_access_key_id')
  grep -q '^S3_KEY_ID=' "$STATE_FILE" || echo "S3_KEY_ID=$S3_KEY_ID" >> "$STATE_FILE"
  S3_SECRET=$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret')
  AWS_ACCESS_KEY_ID="$S3_KEY_ID" AWS_SECRET_ACCESS_KEY="$S3_SECRET" aws s3 mb "s3://$BUCKET" --endpoint-url "$ENDPOINT" --region "$REGION" 2>/dev/null || true
  say "bucket s3://$BUCKET"

  # 3. The keys, in MysteryBox — never in the image and never on the command line of the job.
  set -a; source <(grep -E '^(NEBIUS_API_KEY|NEBIUS_PROJECT_ID)=' .env); set +a
  PAYLOAD=$(jq -cn --arg a "$NEBIUS_API_KEY" --arg p "$NEBIUS_PROJECT_ID" --arg k "$S3_KEY_ID" --arg s "$S3_SECRET" \
    '[{key:"NEBIUS_API_KEY",string_value:$a},{key:"NEBIUS_PROJECT_ID",string_value:$p},{key:"APOLLO_S3_KEY_ID",string_value:$k},{key:"APOLLO_S3_SECRET",string_value:$s}]')
  if [[ -z "${SECRET_ID:-}" ]]; then
    SECRET_ID=$(nebius mysterybox secret create --name "$NAME-keys" --description "Apollo Live watcher keys" --secret-version-payload "$PAYLOAD" --format json | jq -r '.metadata.id')
    echo "SECRET_ID=$SECRET_ID" >> "$STATE_FILE"
  fi
  unset PAYLOAD S3_SECRET NEBIUS_API_KEY
  say "secret $SECRET_ID"
fi

# 4. Hand over the watch this machine is running, so the job continues it rather than starting a
#    new one from "now": stop the local watcher (it saves as it stops), then push its state.
if [[ "${1:-}" != "--relaunch" && -f local/firehose/state.json ]]; then
  PIDFILE="$HOME/stakeout-index-work/firehose-live.pid"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill -TERM "$(cat "$PIDFILE")"
    while kill -0 "$(cat "$PIDFILE")" 2>/dev/null; do sleep 2; done
    say "stopped the local watcher"
  fi
  APOLLO_STATE_S3="s3://$BUCKET/$PREFIX" APOLLO_S3_KEY_ID="$S3_KEY_ID" \
    APOLLO_S3_SECRET="$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret')" \
    node -e 'require("./firehose/mirror").Mirror.fromEnv().push("local/firehose",{force:true}).then((r)=>{if(r.failed.length){console.error(r.failed.join("; "));process.exit(1)}console.log("  handed over: "+r.pushed.join(", "))})'
fi

# 5. The job. `secret-id:key` is the selector form the MysteryBox overview gives.
nebius ai job create \
  --name "$NAME-$(date -u +%m%d-%H%M)" \
  --image "$IMAGE" \
  --platform cpu-e2 --preset 2vcpu-8gb --on-demand \
  --disk-size 30Gi \
  --timeout 168h \
  --restart-policy on-failure \
  --env "APOLLO_STATE_S3=s3://$BUCKET/$PREFIX" \
  --env "APOLLO_S3_ENDPOINT=$ENDPOINT" \
  --env "APOLLO_S3_REGION=$REGION" \
  --env-secret "NEBIUS_API_KEY=$SECRET_ID:NEBIUS_API_KEY" \
  --env-secret "NEBIUS_PROJECT_ID=$SECRET_ID:NEBIUS_PROJECT_ID" \
  --env-secret "APOLLO_S3_KEY_ID=$SECRET_ID:APOLLO_S3_KEY_ID" \
  --env-secret "APOLLO_S3_SECRET=$SECRET_ID:APOLLO_S3_SECRET" \
  --async

say "job started. In about five minutes: bash deploy/nebius/launch.sh --health"
say "if that says it cannot tell or unhealthy: nebius ai job list, then the job's logs in the console"
