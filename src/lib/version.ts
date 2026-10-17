import { readFileSync } from 'node:fs';

/**
 * Build and deployment metadata for `GET /version`.
 *
 * The version is read from `package.json` once, at startup, so the endpoint
 * cannot report something different from the code that is actually running.
 * `../../package.json` resolves to the repository root both from `src/lib`
 * (tsx, vitest) and from `dist/lib` (the compiled build).
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // A deployment that ships without package.json still has to answer
    // /version, so fall through to a clearly-bogus placeholder instead of
    // failing at boot.
  }
  return '0.0.0';
}

/** `version` from package.json, resolved once when this module loads. */
export const APP_VERSION = readPackageVersion();

/** When this process started, in ISO 8601 form. */
export const STARTED_AT = new Date().toISOString();

/**
 * The commit this build was deployed from.
 *
 * Render exposes it as `RENDER_GIT_COMMIT`; other build systems use
 * `GIT_COMMIT`. Read at call time (not module load) so a test can control
 * it, and null when neither is set rather than inventing a value.
 */
export function deployedCommit(source: NodeJS.ProcessEnv = process.env): string | null {
  const commit = source.RENDER_GIT_COMMIT ?? source.GIT_COMMIT;
  if (typeof commit !== 'string') return null;
  const trimmed = commit.trim();
  return trimmed.length > 0 ? trimmed : null;
}
