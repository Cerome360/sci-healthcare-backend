import { describe, expect, it } from 'vitest';

import { BACKOFF_JITTER, nextDelay, nextPollDelay } from '../stellar/indexer.js';

const BASE = 1000;
const MAX = 60_000;

/** The delay before jitter, which is what the bounds are expressed against. */
function unjittered(failures: number): number {
  return Math.min(MAX, BASE * 2 ** (failures - 1));
}

describe('nextDelay', () => {
  it('returns the plain poll interval when nothing has failed', () => {
    expect(nextDelay(0, BASE, MAX, () => 0)).toBe(BASE);
    expect(nextDelay(-1, BASE, MAX, () => 1)).toBe(BASE);
  });

  it('doubles with each consecutive failure', () => {
    const noJitter = () => 0;
    expect(nextDelay(1, BASE, MAX, noJitter)).toBe(1000);
    expect(nextDelay(2, BASE, MAX, noJitter)).toBe(2000);
    expect(nextDelay(3, BASE, MAX, noJitter)).toBe(4000);
    expect(nextDelay(4, BASE, MAX, noJitter)).toBe(8000);
  });

  it('caps at the maximum, jitter included', () => {
    for (const failures of [7, 8, 20, 1000]) {
      expect(nextDelay(failures, BASE, MAX, () => 1)).toBe(MAX);
      expect(nextDelay(failures, BASE, MAX, () => 0)).toBe(MAX);
    }
  });

  it('never overflows on an absurdly long outage', () => {
    expect(Number.isFinite(nextDelay(5000, BASE, MAX, () => 0.5))).toBe(true);
    expect(nextDelay(5000, BASE, MAX, () => 0.5)).toBe(MAX);
  });

  it('stays within the jitter bounds for every random value', () => {
    for (const failures of [1, 2, 3, 4, 5, 6]) {
      const floor = unjittered(failures);
      const ceiling = Math.min(MAX, Math.round(floor * (1 + BACKOFF_JITTER)));
      for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.999]) {
        const delay = nextDelay(failures, BASE, MAX, () => r);
        expect(delay).toBeGreaterThanOrEqual(floor);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeLessThanOrEqual(MAX);
      }
    }
  });

  it('grows monotonically as failures accumulate', () => {
    const half = () => 0.5;
    let previous = 0;
    for (let failures = 1; failures <= 12; failures++) {
      const delay = nextDelay(failures, BASE, MAX, half);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
    expect(previous).toBe(MAX);
  });

  it('spreads retries out rather than returning one fixed delay', () => {
    const delays = new Set(
      [0.1, 0.3, 0.6, 0.9].map((r) => nextDelay(3, BASE, MAX, () => r)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('nextPollDelay', () => {
  it('is unchanged by the backoff: a backlog still polls immediately', () => {
    expect(nextPollDelay(true, BASE)).toBe(0);
    expect(nextPollDelay(false, BASE)).toBe(BASE);
  });
});
