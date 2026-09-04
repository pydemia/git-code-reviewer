# syntax=docker/dockerfile:1.7
ARG RUNTIME_BASE=node:22-alpine
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@10.17.1
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile \
  && pnpm build

FROM ${RUNTIME_BASE} AS runtime
ARG VERSION=0.1.0
ARG REVISION=development
ARG REUSE_RUNTIME_BASE=false
LABEL org.opencontainers.image.title="Git Code Reviewer" \
  org.opencontainers.image.description="Browser-based pull request review service for GitHub Enterprise Server" \
  org.opencontainers.image.source="https://github.com/pydemia/git-code-reviewer" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}"
USER root
RUN if [ "${REUSE_RUNTIME_BASE}" != "true" ]; then apk add --no-cache git tini; fi \
  && mkdir -p /app /var/lib/git-code-reviewer/artifacts /tmp/git-code-reviewer/workspaces \
  && chown -R node:node /app /var/lib/git-code-reviewer /tmp/git-code-reviewer
WORKDIR /app
ENV NODE_ENV=production \
  APP_VERSION=${VERSION} \
  WEB_DIST=/app/apps/web/dist \
  MIGRATIONS_DIR=/app/packages/db/migrations \
  ARTIFACT_ROOT=/var/lib/git-code-reviewer/artifacts \
  WORKSPACE_ROOT=/tmp/git-code-reviewer/workspaces
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/runtime/package.json ./apps/runtime/package.json
COPY --from=build --chown=node:node /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=build --chown=node:node /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/packages/github/package.json ./packages/github/package.json
COPY --from=build --chown=node:node /app/packages/github/node_modules ./packages/github/node_modules
COPY --from=build --chown=node:node /app/packages/github/dist ./packages/github/dist
COPY --from=build --chown=node:node /app/packages/git-engine/package.json ./packages/git-engine/package.json
COPY --from=build --chown=node:node /app/packages/git-engine/dist ./packages/git-engine/dist
COPY --from=build --chown=node:node /app/packages/artifact-store/package.json ./packages/artifact-store/package.json
COPY --from=build --chown=node:node /app/packages/artifact-store/dist ./packages/artifact-store/dist
COPY --from=build --chown=node:node /app/packages/review-contract/package.json ./packages/review-contract/package.json
COPY --from=build --chown=node:node /app/packages/review-contract/node_modules ./packages/review-contract/node_modules
COPY --from=build --chown=node:node /app/packages/review-contract/dist ./packages/review-contract/dist
COPY --from=build --chown=node:node /app/packages/analysis-engine/package.json ./packages/analysis-engine/package.json
COPY --from=build --chown=node:node /app/packages/analysis-engine/node_modules ./packages/analysis-engine/node_modules
COPY --from=build --chown=node:node /app/packages/analysis-engine/dist ./packages/analysis-engine/dist
USER node
EXPOSE 4000 4001
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/runtime/dist/index.js"]
CMD ["serve"]
