# Reference image — see deploy/README.md for the caveats before relying on
# this in production. Native + systemd (deploy/hoopedorc.service) is the
# primary, supported deployment path: the CLIs this app shells out to (gh,
# claude, opencode) need interactive login, which is awkward to bake into an
# image and easy to do once on a real host.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

FROM node:22-slim
WORKDIR /app

# gh, claude, and opencode are all real npm/apt-installable CLIs, but none of
# them are authenticated here — you must mount your already-authenticated
# config dirs at runtime (see deploy/README.md): ~/.config/gh, ~/.claude (or
# wherever `claude` stores its login), and opencode's own auth store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gh git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code opencode-ai

COPY --from=build /app ./

ENV HOST=0.0.0.0
ENV PORT=4317
ENV DB_PATH=/data/hoopedorc.db
ENV REPOS_DIR=/data/repos

EXPOSE 4317
VOLUME ["/data"]

CMD ["npm", "run", "start", "-w", "@orc/server"]
