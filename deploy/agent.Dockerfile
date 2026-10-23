# Sandbox image for agent CLIs. Each agent invocation runs in a fresh container from this image
# (read-only root, tmpfs HOME, explicit mounts, egress only through the proxy).
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.267
ARG CODEX_VERSION=0.154.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# No self-updates or non-essential calls home from inside the sandbox.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    NO_UPDATE_NOTIFIER=1

USER node
WORKDIR /tmp
