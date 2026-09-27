# The box a suspected package is run inside for the malware proof. Node and the probe, nothing else.
# The isolation that matters is applied at `docker run` (proof/harden.js): no network, read-only
# root, dropped capabilities, no host mounts but the one read-only sample. The probe is mounted in at run time (proof/harden.js), so it is never a second copy that can drift.
# This image is only the floor it stands on.
FROM node:22-slim
WORKDIR /run
USER node
ENTRYPOINT ["node"]
