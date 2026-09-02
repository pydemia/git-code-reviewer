# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@10.17.1
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile=false \
  && pnpm build

FROM node:22-alpine AS runtime
RUN apk add --no-cache git tini \
  && mkdir -p /app /var/lib/git-code-reviewer/artifacts /tmp/git-code-reviewer/workspaces \
  && chown -R node:node /app /var/lib/git-code-reviewer /tmp/git-code-reviewer
WORKDIR /app
ENV NODE_ENV=production \
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
USER node
EXPOSE 4000 4001
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/runtime/dist/index.js"]
CMD ["serve"]
