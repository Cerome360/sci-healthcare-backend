# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# SCI Healthcare backend image.
#
# Two targets are published from this file:
#
#   build   - everything, including the Prisma CLI, used by the `migrate`
#             service in docker-compose.yml to apply the schema before the
#             API starts.
#   runtime - production dependencies only, non-root, runs `dist/index.js`.
#
# The committed schema stays on SQLite; `scripts/use-postgres.sh` flips it to
# Postgres inside the image, so a contributor cloning the repo still needs no
# database to run the test suite.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# install first so a source-only change does not re-resolve dependencies.
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN ./scripts/use-postgres.sh \
  && npx prisma generate \
  && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts: the generated client is copied from the build stage below,
# so @prisma/client's postinstall must not run (it would need the Prisma CLI,
# which is a devDependency and is not installed here).
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

# Generated Prisma client and its query engine, built for the Postgres schema.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist

# The image never needs to write to disk; run it as the unprivileged user that
# ships with the Node image.
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
