FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter '@app/api...' --prod=false

FROM deps AS build
COPY packages/tsconfig packages/tsconfig
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm -F @app/contracts build && pnpm -F @app/api build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/src/prompts /app/apps/api/src/prompts
COPY --from=build --chown=app:app /app/node_modules /app/node_modules
COPY --from=build --chown=app:app /app/packages/contracts/dist /app/packages/contracts/dist
USER app
EXPOSE 8080
CMD ["node", "/app/apps/api/dist/index.js"]
