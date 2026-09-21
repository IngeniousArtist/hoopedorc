# Operator-built, immutable-image execution profile. No host credentials or keys.
FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.154.0 \
    && codex --version | grep -Fx 'codex-cli 0.154.0' \
    && mkdir -p /home/worker /account /work /io /proxy
LABEL io.hoopedorc.worker="codex-v1"
WORKDIR /work
