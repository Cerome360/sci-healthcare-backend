import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue #123 moved Prisma's configuration from the deprecated
 * `package.json#prisma` key — warned about before every command and removed
 * in Prisma 7 — to `prisma.config.ts`. Two regressions here would be silent
 * rather than loud, so both are asserted structurally against the files:
 *
 * - the warning's source (the package.json key) must stay gone;
 * - the config file must keep carrying what the key used to carry (the seed
 *   command) and must keep loading the env file itself, because the CLI
 *   stops loading it as soon as a config file exists ("Prisma config
 *   detected, skipping environment variable loading") and every documented
 *   local workflow — `cp .env.example .env`, `npx prisma db push`,
 *   `npm run db:seed` — reads `DATABASE_URL` from that file.
 */

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  engines?: { node?: string };
  devDependencies?: Record<string, string | undefined>;
  scripts?: Record<string, string | undefined>;
};
const config = readFileSync(new URL('../../prisma.config.ts', import.meta.url), 'utf8');

describe('package.json', () => {
  it('keeps the Prisma scripts that must keep working (canary)', () => {
    expect(pkg.scripts?.['db:generate']).toBe('prisma generate');
    expect(pkg.scripts?.['db:push']).toBe('prisma db push');
    expect(pkg.scripts?.['db:migrate']).toBe('prisma migrate deploy');
    expect(pkg.scripts?.['db:seed']).toBe('prisma db seed');
  });

  it('no longer carries the deprecated prisma configuration key', () => {
    // This is the key every command printed a deprecation warning for.
    expect('prisma' in pkg).toBe(false);
  });

  it('declares a Node floor that has process.loadEnvFile (>= 20.12)', () => {
    const match = (pkg.engines?.node ?? '').match(/>=\s*(\d+)\.(\d+)/);
    expect(match, pkg.engines?.node ?? '(no engines.node)').not.toBeNull();
    if (!match) return;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    expect(major > 20 || (major === 20 && minor >= 12)).toBe(true);
  });

  it('keeps tsx available for the seed command', () => {
    expect(pkg.devDependencies?.tsx).toBeTruthy();
  });
});

describe('prisma.config.ts', () => {
  it('is loaded through the supported prisma/config entry point', () => {
    expect(config).toContain("from 'prisma/config'");
    expect(config).toContain('defineConfig');
  });

  it('declares the schema and migrations paths the commands resolve', () => {
    expect(config).toMatch(/schema:\s*'prisma\/schema\.prisma'/);
    expect(config).toMatch(/path:\s*'prisma\/migrations'/);
    expect(existsSync(new URL('../../prisma/schema.prisma', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../prisma/migrations', import.meta.url))).toBe(true);
  });

  it('carries the seed command the package.json key used to carry', () => {
    expect(config).toMatch(/seed:\s*'tsx prisma\/seed\.ts'/);
    expect(existsSync(new URL('../../prisma/seed.ts', import.meta.url))).toBe(true);
  });

  it('loads the env file itself, guarded, because the CLI skips it', () => {
    // loadEnvFile throws ENOENT and every CI job and the Docker build stage
    // have no env file at all, so the load must sit inside the exists guard —
    // and without the load, `npx prisma db push` on a fresh clone fails with
    // P1012: Environment variable not found: DATABASE_URL.
    expect(config).toMatch(
      /if \(existsSync\('\.env'\)\) \{\s*process\.loadEnvFile\('\.env'\);\s*\}/,
    );
  });
});
