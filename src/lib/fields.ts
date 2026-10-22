import { ApiError } from './errors.js';

/**
 * Sparse fieldsets for list routes (#166).
 *
 * `?fields=id,status,amount` lets a client on a slow connection ask for only
 * the fields it renders. The value is validated against the route's allow-list:
 * an unknown field is a 400, so a typo can never silently return the full row.
 *
 * Returns `null` when the client asked for nothing (or an empty value), which
 * means the route must respond exactly as it did before this feature existed.
 */
export function parseFields(
  raw: string | undefined,
  allowed: readonly string[],
  route: string,
): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const requested = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (requested.length === 0) return null;
  const unknown = requested.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'unknown_fields',
      `Unknown fields for ${route}: ${unknown.join(', ')}`,
      { unknown, allowed: [...allowed] },
    );
  }
  // A field listed twice is still one field.
  return [...new Set(requested)];
}

/**
 * Projects a serialised list item onto the requested subset of fields.
 * Keys are top-level only: asking for `provider` keeps the whole provider
 * object, and a field the serialiser did not emit (e.g. `beneficiaryRef` on
 * the provider view of `/receipts`) is simply absent.
 */
export function applyFields<T extends Record<string, unknown>>(
  row: T,
  fields: string[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(row, f)) {
      out[f as keyof T] = row[f as keyof T];
    }
  }
  return out;
}