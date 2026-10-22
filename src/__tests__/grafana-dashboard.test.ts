import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `ops/grafana-dashboard.json` is operator-facing configuration, so its
 * acceptance criteria are asserted structurally against the files rather
 * than against a live Grafana: it parses as a dashboard Grafana can import,
 * it covers the metrics `src/lib/metrics.ts` actually exposes, and it
 * queries nothing this service does not serve. Renaming a metric fails
 * here instead of silently blanking a panel in production.
 */

interface DashboardTarget {
  expr?: unknown;
  refId?: unknown;
  datasource?: { uid?: unknown };
}

interface DashboardPanel {
  id?: unknown;
  title?: unknown;
  type?: unknown;
  gridPos?: { x?: unknown; w?: unknown; h?: unknown };
  datasource?: { uid?: unknown };
  targets?: DashboardTarget[];
}

interface Dashboard {
  title?: unknown;
  uid?: unknown;
  schemaVersion?: unknown;
  __inputs?: { name?: unknown; pluginId?: unknown; type?: unknown }[];
  panels?: DashboardPanel[];
}

const dashboardText = readFileSync(
  new URL('../../ops/grafana-dashboard.json', import.meta.url),
  'utf8',
);
const dashboard = JSON.parse(dashboardText) as Dashboard;
const metricsSource = readFileSync(new URL('../lib/metrics.ts', import.meta.url), 'utf8');

/** Metric names declared in src/lib/metrics.ts (`name: '…'`). */
function declaredMetrics(): string[] {
  return [...metricsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1] as string);
}

/** PromQL functions and labels the dashboard's expressions may use. */
const promqlKeywords = new Set([
  'rate', 'sum', 'histogram_quantile', 'by', 'le', 'name', 'route', 'method', 'status_code',
  'A', 'B', 'C',
]);

/**
 * App metric references in an expression: identifiers under the prefixes our
 * `/metrics` endpoint serves, with histogram/summary series suffixes removed.
 * prom-client default metrics (`process_*`, `nodejs_*`) are deliberately not
 * matched — the dashboard is about the service, not the runtime.
 */
function appMetricRefs(expr: string): string[] {
  const refs: string[] = [];
  for (const match of expr.matchAll(/\b([a-z][a-z0-9_]*)\b/g)) {
    const token = match[1] as string;
    if (!/^(http|indexer|events|stream)_/.test(token)) continue;
    if (promqlKeywords.has(token)) continue;
    refs.push(token.replace(/_(bucket|sum|count)$/, ''));
  }
  return refs;
}

function targetsOf(panel: DashboardPanel): DashboardTarget[] {
  return Array.isArray(panel.targets) ? panel.targets : [];
}

function exprsOf(panel: DashboardPanel): string[] {
  return targetsOf(panel)
    .map((t) => t.expr)
    .filter((e): e is string => typeof e === 'string');
}

function allExprs(): string[] {
  return (dashboard.panels ?? []).flatMap(exprsOf);
}

function panelByTitle(title: string): DashboardPanel | undefined {
  return (dashboard.panels ?? []).find((p) => p.title === title);
}

describe('ops/grafana-dashboard.json', () => {
  it('is a dashboard Grafana can import (canary for the assertions below)', () => {
    expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(36);
    expect(dashboard.title).toBe('SCI Healthcare — API & Indexer');
    expect(dashboard.uid).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.isArray(dashboard.panels)).toBe(true);
    expect(dashboard.panels?.length).toBeGreaterThan(0);
  });

  it('asks the importer for a Prometheus datasource', () => {
    const input = (dashboard.__inputs ?? []).find((i) => i.name === 'DS_PROMETHEUS');
    expect(input?.type).toBe('datasource');
    expect(input?.pluginId).toBe('prometheus');
    // Every panel and target must point at the datasource the import
    // substitutes, or the panels come up empty after import.
    for (const panel of dashboard.panels ?? []) {
      expect(panel.datasource?.uid, String(panel.title)).toBe('${DS_PROMETHEUS}');
      for (const target of targetsOf(panel)) {
        expect(target.datasource?.uid, String(panel.title)).toBe('${DS_PROMETHEUS}');
      }
    }
  });

  it('gives every panel a unique id and a grid position inside the 24-column row', () => {
    const ids = (dashboard.panels ?? []).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of dashboard.panels ?? []) {
      const x = panel.gridPos?.x as number;
      const w = panel.gridPos?.w as number;
      const h = panel.gridPos?.h as number;
      expect(x, String(panel.title)).toBeGreaterThanOrEqual(0);
      expect(x + w, String(panel.title)).toBeLessThanOrEqual(24);
      expect(h, String(panel.title)).toBeGreaterThan(0);
    }
  });

  it('only queries metrics src/lib/metrics.ts declares', () => {
    const declared = new Set(declaredMetrics());
    // Canary: the parser must find the metrics before the check below means
    // anything.
    expect(declared.has('http_requests_total')).toBe(true);
    expect(declared.has('indexer_lag_ledgers')).toBe(true);

    for (const expr of allExprs()) {
      for (const ref of appMetricRefs(expr)) {
        expect(declared.has(ref), `unknown metric ${ref} in: ${expr}`).toBe(true);
      }
    }
  });

  it('covers every metric src/lib/metrics.ts declares', () => {
    const queried = new Set(allExprs().flatMap(appMetricRefs));
    for (const metric of declaredMetrics()) {
      expect(queried.has(metric), `metric ${metric} has no panel`).toBe(true);
    }
  });

  it('has the panels this issue asks for', () => {
    const rate = panelByTitle('Request rate');
    expect(rate, 'request rate panel').toBeDefined();
    expect(exprsOf(rate as DashboardPanel).join('\n')).toContain('http_requests_total');

    const latency = panelByTitle('Request latency (p50 / p95 / p99)');
    expect(latency, 'latency panel').toBeDefined();
    const latencyExprs = exprsOf(latency as DashboardPanel);
    expect(latencyExprs.length).toBe(3);
    for (const expr of latencyExprs) {
      // histogram_quantile needs the cumulative _bucket series, never the
      // raw family name or the already-aggregated _sum.
      expect(expr, expr).toContain('http_request_duration_seconds_bucket');
      expect(expr, expr).toContain('histogram_quantile');
      expect(expr, expr).toContain('by (le)');
    }

    const lag = panelByTitle('Indexer lag (ledgers)');
    expect(lag, 'lag panel').toBeDefined();
    expect(exprsOf(lag as DashboardPanel).join('\n')).toContain('indexer_lag_ledgers');

    const applied = panelByTitle('Events applied');
    expect(applied, 'events applied panel').toBeDefined();
    const appliedExpr = exprsOf(applied as DashboardPanel).join('\n');
    expect(appliedExpr).toContain('events_applied_total');
    expect(appliedExpr).toContain('by (name)');

    const skipped = panelByTitle('Events skipped (failed projections)');
    expect(skipped, 'events skipped panel').toBeDefined();
    expect(exprsOf(skipped as DashboardPanel).join('\n')).toContain('events_skipped_total');
  });
});
