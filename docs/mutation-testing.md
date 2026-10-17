# Mutation testing

[Stryker](https://stryker-mutator.io/) mutates `src/lib/lifecycle.ts` and
`src/lib/amounts.ts` and checks whether the test suite notices. Those two
files are small, pure, and mirrored by the voucher contract — a stale refund
flag or an off-by-one conversion is exactly the kind of bug this suite exists
to catch, and mutation testing measures whether the tests would actually
catch it.

```sh
npm run mutation
```

Deliberately **not** part of CI: a Stryker run is far slower than the test
suite and belongs to periodic quality checks, not every PR. `coverageAnalysis:
perTest` keeps it quick — each mutant is only checked against the tests that
cover its line. The JSON report lands in `reports/mutation/` (gitignored).

## Latest result — 2026-10-16, Stryker 10.0.0, vitest runner

| file | mutation score | killed | survived | no coverage | errors |
| --- | --- | --- | --- | --- | --- |
| `src/lib/lifecycle.ts` | 100% | 34 | 0 | 0 | 0 |
| `src/lib/amounts.ts` | 100% | 36 | 0 | 0 | 0 |

The first run scored `amounts.ts` at 77.5%: the negative-amount branch of
`fromBaseUnits` had no test at all, short fractions (`toBaseUnits('1.5')`)
were never padded, whitespace trimming was never exercised, and the
malformed-input tests accepted any throw — so the validation regex could
lose an anchor and the error message could vanish without a failure. The
added tests close all of those.

## Equivalent mutants

Two `StringLiteral` mutants in `amounts.ts` are annotated inline with
`// Stryker disable next-line` instead of being killed, because no input can
distinguish the mutant from the original:

- `const [whole = '0', frac = ''] = trimmed.split('.')` — `split()` always
  yields at least index 0, so the `'0'` default can never fire; it exists
  only to satisfy `noUncheckedIndexedAccess`.
- `BigInt(padded || '0')` — `frac.padEnd(DECIMALS, '0').slice(0, DECIMALS)`
  can never produce `''`, so the fallback can never fire.

Both lines carry the reason next to the annotation. Killing equivalent
mutants with artificial tests would add noise without adding protection;
annotating keeps future runs clean and the report honest.
