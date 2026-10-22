import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `ops/alerts.yml` is operator-facing configuration, so its acceptance
 * criteria are asserted structurally against the file text, the same way
 * `ci-workflows.test.ts` checks the workflows and `grafana-dashboard.test.ts`
 * checks the dashboard. promtool is the real validator and CI runs
 * `promtool check rules ops/alerts.yml`; what is checked here is the part
 * promtool cannot know — that every expression references a metric
 * `src/lib/metrics.ts` actually serves, so renaming one fails this test
 * instead of leaving an alert that never fires.
 */

const alertsText = readFileSync(new URL('../../ops/alerts.yml', import.meta.url), 'utf8');
const metricsSource = readFileSync(new URL('../lib/metrics.ts', import.meta.url), 'utf8');

/** One rule per `- alert:` entry, with the text under it. */
function alertBlocks(): { name: string; body: string }[] {
  return alertsText
    .split(/^\s*- alert: /m)
    .slice(1)
    .map((part) => {
      const [name, ...rest] = part.split('\n');
      return { name: (name ?? '').trim(), body: rest.join('\n') };
    });
}

/** The `expr:` value of a rule, including a block scalar's indented lines. */
function exprOf(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^\s*expr:/.test(line));
  if (start === -1) return '';
  const collected = [(lines[start] ?? '').replace(/^\s*expr:\s*/, '')];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s+(for|labels|annotations|expr):/.test(line)) break;
    collected.push(line);
  }
  return collected.join(' ');
}

/** Metric names declared in src/lib/metrics.ts (`name: '…'`). */
function declaredMetrics(): string[] {
  return [...metricsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1] as string);
}

/**
 * App metric references in an expression, with histogram series suffixes
 * removed. prom-client default metrics (`process_*`, `nodejs_*`) are
 * deliberately not matched: the alerts are about this service.
 */
function appMetricRefs(expr: string): string[] {
  return [...expr.matchAll(/\b([a-z][a-z0-9_]*)\b/g)]
    .map((m) => m[1] as string)
    .filter((token) => /^(http|indexer|events|stream|webhook)_/.test(token))
    .map((token) => token.replace(/_(bucket|sum|count)$/, ''));
}

describe('ops/alerts.yml', () => {
  const alerts = alertBlocks();

  it('parses the rule file (canary for the assertions below)', () => {
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    expect(alerts.map((a) => a.name)).toContain('SciIndexerLagging');
  });

  it('has the alerts this issue asks for (#131)', () => {
    const names = alerts.map((a) => a.name);
    // Indexer lag, failed events, 5xx rate and the webhook backlog (#130).
    for (const required of ['SciIndexerLagging', 'SciFailedEvents', 'SciHigh5xxRate', 'SciWebhookBacklog']) {
      expect(names, `missing alert ${required}`).toContain(required);
    }
  });

  it('gives every rule an expression, a duration, a severity and a summary', () => {
    for (const { name, body } of alerts) {
      expect(exprOf(body).trim().length, name).toBeGreaterThan(0);
      expect(body, name).toMatch(/^\s+for: \d+[smh]$/m);
      expect(body, name).toMatch(/^\s+severity: (warning|critical)$/m);
      expect(body, name).toMatch(/^\s+summary: \S/m);
    }
  });

  it('only references metrics src/lib/metrics.ts serves', () => {
    const declared = new Set(declaredMetrics());
    // Canary: the parser must find the metrics before this check means
    // anything.
    expect(declared.has('indexer_lag_ledgers')).toBe(true);
    expect(declared.has('webhook_deliveries_pending')).toBe(true);

    for (const { name, body } of alerts) {
      const refs = appMetricRefs(exprOf(body));
      expect(refs.length, name).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(declared.has(ref), `unknown metric ${ref} in alert ${name}`).toBe(true);
      }
    }
  });

  it('documents where the metric comes from, so an operator knows what to scrape', () => {
    // The webhook series only move in the process running the delivery loop,
    // and the indexer series only in the process running the indexer; an
    // alert on a series nobody scrapes can never fire.
    expect(alertsText).toMatch(/combined mode, or the worker/);
  });
});
