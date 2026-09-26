# Stakeout Live on Nebius Serverless Jobs: the npm watcher, supervised, with its state mirrored.
#
#   docker build -f deploy/nebius/Dockerfile -t stakeout-live .      (from the repository root)
#
# Zero dependencies — the image is Node and the files in .dockerignore's allow-list. Runs as a
# non-root user; the state directory is scratch, because the real state lives in the mirror
# (STAKEOUT_STATE_S3) and a new job restores it before its first poll.
FROM node:22-slim
WORKDIR /stakeout
COPY . .
RUN mkdir -p /stakeout/local/firehose && chown -R node:node /stakeout/local
USER node
ENV NODE_ENV=production
# 167 h: one hour inside the 168 h ceiling on a job, so the watcher stops and pushes its state
# itself rather than being killed mid-write by the platform.
CMD ["node", "scripts/firehose-supervise.js", "--hours", "167", "--concurrency", "10"]
