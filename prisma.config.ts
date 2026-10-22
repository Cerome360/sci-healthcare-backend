import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

/**
 * Prisma configuration (issue #123).
 *
 * Replaces the deprecated `package.json#prisma` key, which every Prisma
 * command warned about and which Prisma 7 removes entirely. The old key
 * only ever carried the seed command; the schema and migrations paths are
 * spelled out here so commands resolve them from the repository root
 * regardless of the current working directory.
 *
 * https://pris.ly/prisma-config
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});

// Once a config file exists the CLI prints "Prisma config detected,
// skipping environment variable loading" and reads no `.env` at all — and
// nothing else in this repository loads one. The documented quick start
// (`cp .env.example .env`, then `npx prisma db push`), `npm run db:seed`
// and `npm run db:migrate` all depend on that file, so load it here, in
// the same process every Prisma command runs.
//
// `process.loadEnvFile` never overrides a variable already in the
// environment — CI, Docker and Render pass theirs explicitly and keep
// precedence — and it needs Node >= 20.12, which `engines` now states.
// The exists check keeps a checkout without a `.env` (every CI job, the
// Docker build stage) working, exactly like the CLI's own silent skip.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
