import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { isPostgresUrl, TEST_DATABASE_PATH, testDatabaseUrl } from './database-url.js';

/**
 * Creates a fresh test database from the schema once per run.
 *
 * SQLite: the file is throwaway and only ever lives at prisma/test.db, so it
 * is removed and recreated rather than reset in place.
 *
 * Postgres: the URL came from the environment, so we do not assume we own
 * it. The schema is dropped and recreated explicitly instead of using
 * `--force-reset`, which would wipe whatever DATABASE_URL happens to point
 * at. `prisma db execute` is used so this needs no extra client (psql).
 */
export default function setup(): void {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url };

  if (isPostgresUrl(url)) {
    execSync('npx prisma db execute --schema prisma/schema.prisma --stdin', {
      env,
      input: 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n',
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  } else {
    for (const suffix of ['', '-journal']) {
      rmSync(TEST_DATABASE_PATH + suffix, { force: true });
    }
  }

  execSync('npx prisma db push --skip-generate', {
    env,
    stdio: 'ignore',
  });
}
