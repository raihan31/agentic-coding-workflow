# Orchestrator image: worker, API and web UI (one image, the command picks the role).
# Build from the repo root: docker build -f deploy/orchestrator.Dockerfile -t agentic-orchestrator:local .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run ui:build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git: worktrees and commits; ca-certificates: TLS to Temporal, Postgres, GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist
ENV NODE_ENV=production LOG_FORMAT=json
USER node
ENTRYPOINT ["tini", "--", "node", "--import", "tsx", "src/cli.ts"]
CMD ["--help"]
