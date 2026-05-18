// Prometheus exposition.
//
// Production posture per RELIABILITY.md: deployer fronts /metrics with
// basic-auth (Traefik). At the app layer, `METRICS_TOKEN` env var adds
// an optional Bearer-token gate as defense in depth. Unset → endpoint
// is reachable; set → 401 without the matching token.

import client, { Counter, Histogram, Registry } from 'prom-client';
import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from './server.js';
import { renderRouteHealthMetrics, summarizeRouteHealth } from './proxy/service/genericRouteHealth.js';

const registry = new Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'openai_service_' });

// ── Custom metrics ────────────────────────────────────────────────────

export const httpRequestsTotal = new Counter({
  name: 'openai_service_http_requests_total',
  help: 'Total HTTP requests received.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'openai_service_http_request_duration_seconds',
  help: 'HTTP request latency, seconds.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const proxyReservationsTotal = new Counter({
  name: 'openai_service_proxy_reservations_total',
  help: 'Proxy /v1/* reservation lifecycle outcomes.',
  labelNames: ['capability', 'outcome'] as const,
  registers: [registry],
});

export const waitlistSignupsTotal = new Counter({
  name: 'openai_service_waitlist_signups_total',
  help: 'Public waitlist signups received.',
  registers: [registry],
});

// ── Wiring ────────────────────────────────────────────────────────────

export function attachHttpMetrics(app: FastifyInstance): void {
  // Use Fastify's matched route pattern, not the raw URL, to keep label
  // cardinality bounded.
  app.addHook('onRequest', async (req) => {
    (req as unknown as { _startNs?: bigint })._startNs = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as { _startNs?: bigint })._startNs;
    if (start === undefined) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.routeOptions.url ?? req.url.split('?')[0] ?? 'unknown';
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    httpRequestDurationSeconds.observe({ method: req.method, route }, seconds);
  });
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  const token = deps.config.metricsToken;
  app.get('/metrics', async (req, reply) => {
    if (token) {
      const header = req.headers['authorization'];
      const provided =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice(7)
          : null;
      if (provided !== token) {
        return reply.code(401).send('unauthorized');
      }
    }

    // Compose: default registry + route-health renderer (uses
    // RouteSelector's own snapshot rather than copying).
    const snapshots = deps.routeSelector.inspectHealth();
    const summary = summarizeRouteHealth(snapshots);
    const metrics = deps.routeSelector.inspectMetrics();
    const routeHealthText = renderRouteHealthMetrics(
      'openai-service-gateway',
      summary,
      metrics,
    );

    const main = await registry.metrics();
    void reply
      .header('Content-Type', registry.contentType)
      .send(main + '\n' + routeHealthText);
  });
}
