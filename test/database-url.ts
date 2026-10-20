import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The throwaway SQLite file route tests run against. Never a real database. */
export const TEST_DATABASE_PATH = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '../prisma/test.db')
  .replaceAll('\\', '/');

export const TEST_DATABASE_URL = `file:${TEST_DATABASE_PATH}`;

/** True for a Postgres connection string. */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//.test(url);
}

/**
 * The database the suite runs against.
 *
 * SQLite is the default so `npm test` needs nothing installed. CI also runs
 * the same suite against a Postgres service container by exporting
 * DATABASE_URL; when that is a Postgres URL it is used as-is, because the
 * point is to exercise the engine production actually runs.
 */
export function testDatabaseUrl(): string {
  const provided = process.env.DATABASE_URL;
  return provided && isPostgresUrl(provided) ? provided : TEST_DATABASE_URL;
}
