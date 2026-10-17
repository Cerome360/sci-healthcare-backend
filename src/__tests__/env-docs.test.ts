import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The environment reference in the README must match the Zod schema in
 * `src/env.ts`: every variable documented, nothing documented that the
 * schema does not accept, and the Required/Default columns agreeing with
 * the schema's own definitions.
 *
 * The schema is parsed as text, not imported, because importing
 * `src/env.ts` validates `process.env` at module scope.
 */

const envSource = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

type SchemaVar = { name: string; required: boolean; defaultValue: string | null };

function schemaVars(): SchemaVar[] {
  const start = envSource.indexOf('const schema = z.object({');
  const body = envSource.slice(start, envSource.indexOf('});', start));

  const keys: { name: string; at: number }[] = [];
  for (const match of body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)) {
    const name = match[1];
    if (name !== undefined && match.index !== undefined) keys.push({ name, at: match.index });
  }

  return keys.map(({ name, at }, i) => {
    const next = keys[i + 1];
    const entry = body.slice(at, next ? next.at : body.length);
    // Matches `.default(8080)`, `.default('info')`, and numeric separators like `.default(60_000)`
    const def = entry.match(/\.default\((?:'([^']*)'|([\d_]+))\)/);
    return {
      name,
      required: !def && !entry.includes('.optional()'),
      defaultValue: def ? (def[1] ?? def[2]?.replaceAll('_', '') ?? null) : null,
    };
  });
}

type ReadmeVar = { required: string; defaultValue: string; purpose: string };

function readmeVars(): Map<string, ReadmeVar> {
  const start = readme.indexOf('## Environment');
  const rest = readme.slice(start + 1);
  const nextHeading = rest.indexOf('\n## ');
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const vars = new Map<string, ReadmeVar>();
  for (const line of section.split('\n')) {
    if (!/^\| `[A-Z][A-Z0-9_]*` \|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.replaceAll('`', '').trim());
    const [name, required, defaultValue, , purpose] = cells;
    if (name === undefined) continue;
    vars.set(name, {
      required: required ?? '',
      defaultValue: defaultValue ?? '',
      purpose: purpose ?? '',
    });
  }
  return vars;
}

describe('README environment reference', () => {
  const schema = schemaVars();
  const documented = readmeVars();

  it('parses the Zod schema (canary for the assertions below)', () => {
    expect(schema.find((v) => v.name === 'DATABASE_URL')).toEqual({
      name: 'DATABASE_URL',
      required: true,
      defaultValue: null,
    });
    expect(schema.find((v) => v.name === 'PORT')).toEqual({
      name: 'PORT',
      required: false,
      defaultValue: '8080',
    });
  });

  it('documents every variable in src/env.ts, and only those', () => {
    expect([...documented.keys()].sort()).toEqual(schema.map((v) => v.name).sort());
  });

  it('agrees with the schema on which variables are required', () => {
    for (const { name, required } of schema) {
      expect(documented.get(name)?.required, name).toBe(required ? 'Yes' : 'No');
    }
  });

  it('agrees with the schema on defaults, and says so when there is none', () => {
    for (const { name, defaultValue } of schema) {
      expect(documented.get(name)?.defaultValue, name).toBe(defaultValue ?? '—');
    }
  });

  it('gives every row a description', () => {
    for (const [name, { purpose }] of documented) {
      expect(purpose, name).not.toBe('');
    }
  });
});
