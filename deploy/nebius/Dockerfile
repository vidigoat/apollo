# Apollo Live on Nebius Serverless Jobs: the npm watcher, supervised, with its state mirrored.
#
#   docker build -f deploy/nebius/Dockerfile -t apollo-live .      (from the repository root)
#
# Zero dependencies — the image is Node and the files in .dockerignore's allow-list. Runs as a
# non-root user; the state directory is scratch, because the real state lives in the mirror
# (APOLLO_STATE_S3) and a new job restores it before its first poll.
FROM node:22-slim
WORKDIR /apollo
COPY . .
RUN mkdir -p /apollo/local/firehose && chown -R node:node /apollo/local
USER node
ENV NODE_ENV=production
# 167 h: one hour inside the 168 h ceiling on a job, so the watcher stops and pushes its state
# itself rather than being killed mid-write by the platform.
CMD ["node", "scripts/firehose-supervise.js", "--hours", "167", "--concurrency", "10"]
