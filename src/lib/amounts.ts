/**
 * On-chain amounts are i128 and routinely exceed Number.MAX_SAFE_INTEGER.
 * They are carried as decimal strings everywhere in this service and only
 * converted for display. Never parse one into a JS number.
 */

/** Stroops per unit for a 7-decimal Stellar asset such as USDC. */
export const DECIMALS = 7;
const SCALE = 10n ** BigInt(DECIMALS);

/** "3.00" -> "30000000" */
export function toBaseUnits(display: string): string {
  const trimmed = display.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a valid decimal amount: ${display}`);
  }
  // Stryker disable next-line StringLiteral: unreachable — split() always yields index 0; default only satisfies noUncheckedIndexedAccess
  const [whole = '0', frac = ''] = trimmed.split('.');
  const padded = frac.padEnd(DECIMALS, '0').slice(0, DECIMALS);
  // Stryker disable next-line StringLiteral: unreachable — padEnd(7,'0').slice(0,7) is never empty, so `|| '0'` cannot fire
  return (BigInt(whole) * SCALE + BigInt(padded || '0')).toString();
}

/** "30000000" -> "3.0000000" */
export function fromBaseUnits(base: string): string {
  const value = BigInt(base);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Basis-point fee, matching the contract's integer truncation exactly. */
export function feeFor(amountBase: string, feeBps: number): string {
  return ((BigInt(amountBase) * BigInt(feeBps)) / 10_000n).toString();
}
