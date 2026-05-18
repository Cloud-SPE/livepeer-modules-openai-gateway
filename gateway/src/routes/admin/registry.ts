// Admin: inspect what the route selector sees right now.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import * as modelsRepo from '../../repo/models.js';
import { loadActiveModelHealth } from '../../registry/modelHealth.js';
import {
  ErrorBody,
  RouteCandidatePublic,
  Timestamp,
} from '../../schema/api.js';

const ADMIN_SECURITY = [{ adminToken: [] as string[] }];

const CandidatesResponse = z
  .object({ data: z.array(RouteCandidatePublic) })
  .meta({ id: 'AdminRegistryCandidates' });

const HealthSnapshot = z.object({
  key: z.string(),
  consecutiveFailures: z.number(),
  coolingDown: z.boolean(),
  cooldownUntil: z.number().nullable(),
  lastFailureAt: z.number().nullable(),
  lastFailureReason: z.string().nullable(),
  lastSuccessAt: z.number().nullable(),
});

const HealthMetrics = z.object({
  attemptsTotal: z.number(),
  successesTotal: z.number(),
  retryableFailuresTotal: z.number(),
  nonRetryableFailuresTotal: z.number(),
  cooldownsOpenedTotal: z.number(),
});

const HealthResponse = z
  .object({ snapshots: z.array(HealthSnapshot), metrics: HealthMetrics })
  .meta({ id: 'AdminRegistryHealth' });

const ModelRow = z.object({
  modelId: z.string(),
  capability: z.string(),
  interactionMode: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  provider: z.string().nullable(),
  category: z.string().nullable(),
  ethAddress: z.string().nullable(),
  pricePerWorkUnitWei: z.string().nullable(),
  brokerUrl: z.string().nullable(),
  unitsPerPrice: z.number().nullable(),
  quoteId: z.string().nullable(),
  quoteVersion: z.string().nullable(),
  constraintFingerprintHex: z.string().nullable(),
  routeFingerprintHex: z.string().nullable(),
  active: z.boolean(),
  snapshotAt: Timestamp,
});

const ModelsResponse = z
  .object({ data: z.array(ModelRow) })
  .meta({ id: 'AdminRegistryModels' });

const RegistrySummaryRow = z.object({
  capability: z.string(),
  count: z.number(),
});

const RegistrySummaryResponse = z
  .object({
    liveCandidates: z.number(),
    liveModels: z.number(),
    cachedActiveModels: z.number(),
    cacheAgeMs: z.number().nullable(),
    cacheFresh: z.boolean(),
    maxCacheAgeMs: z.number(),
    liveOnlyModelIds: z.array(z.string()),
    cachedOnlyModelIds: z.array(z.string()),
    liveByCapability: z.array(RegistrySummaryRow),
    cachedByCapability: z.array(RegistrySummaryRow),
  })
  .meta({ id: 'AdminRegistrySummary' });

const AdminModelHealthRow = z.object({
  id: z.string(),
  capability: z.string(),
  category: z.string(),
  provider: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  selectable: z.boolean(),
  reason: z.string().nullable(),
  routeCount: z.number(),
  offerings: z.array(z.string()),
  interactionModes: z.array(z.string()),
  snapshotAt: Timestamp,
});

const AdminCapabilityHealthRow = z.object({
  capability: z.string(),
  category: z.string(),
  availableModels: z.number(),
  selectableModels: z.number(),
  unavailableModels: z.number(),
});

const AdminModelHealthResponse = z
  .object({
    capabilities: z.array(AdminCapabilityHealthRow),
    models: z.array(AdminModelHealthRow),
  })
  .meta({ id: 'AdminRegistryModelHealth' });

export async function registerAdminRegistryRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/admin/registry/model-health',
    {
      schema: {
        tags: ['admin'],
        summary: 'Registry model health',
        description:
          'Capability and model availability derived from cached models plus live route selection.',
        security: ADMIN_SECURITY,
        response: { 200: AdminModelHealthResponse, 401: ErrorBody },
      },
    },
    async () => {
      const models = await loadActiveModelHealth(deps.db, deps.registryCatalog);
      return {
        capabilities: summarizeModelHealth(models),
        models,
      };
    },
  );

  f.get(
    '/admin/registry/summary',
    {
      schema: {
        tags: ['admin'],
        summary: 'Registry cache vs live resolver summary',
        description:
          'High-signal comparison between the live resolver snapshot and the cached models table.',
        security: ADMIN_SECURITY,
        response: { 200: RegistrySummaryResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const [candidates, rows] = await Promise.all([
        deps.registryCatalog.inspect(),
        modelsRepo.listAll(deps.db),
      ]);
      const activeRows = rows.filter((row) => row.active);
      const latestSnapshotAt = rows.reduce<Date | null>((latest, row) => {
        if (!latest || row.snapshotAt > latest) return row.snapshotAt;
        return latest;
      }, null);
      const cacheAgeMs = latestSnapshotAt ? Date.now() - latestSnapshotAt.getTime() : null;
      const maxCacheAgeMs = Math.max(deps.config.registryRefreshIntervalMs * 2, 120_000);
      const liveModelIds = uniq(
        candidates
          .map((candidate) => (candidate.model ?? candidate.offering ?? '').trim())
          .filter((value) => value.length > 0),
      ).sort();
      const cachedModelIds = uniq(activeRows.map((row) => row.modelId)).sort();
      return {
        liveCandidates: candidates.length,
        liveModels: liveModelIds.length,
        cachedActiveModels: cachedModelIds.length,
        cacheAgeMs,
        cacheFresh: cacheAgeMs !== null && cacheAgeMs <= maxCacheAgeMs,
        maxCacheAgeMs,
        liveOnlyModelIds: liveModelIds.filter((id) => !cachedModelIds.includes(id)),
        cachedOnlyModelIds: cachedModelIds.filter((id) => !liveModelIds.includes(id)),
        liveByCapability: summarizeByCapability(
          candidates.map((candidate) => candidate.capability),
        ),
        cachedByCapability: summarizeByCapability(activeRows.map((row) => row.capability)),
      };
    },
  );

  f.get(
    '/admin/registry/candidates',
    {
      schema: {
        tags: ['admin'],
        summary: 'Live registry catalog candidates',
        description: 'Current live resolver snapshot from the registry catalog surface.',
        security: ADMIN_SECURITY,
        response: { 200: CandidatesResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const candidates = await deps.registryCatalog.inspect();
      return {
        data: candidates.map((c) => ({
          brokerUrl: c.brokerUrl,
          capability: c.capability,
          offering: c.offering,
          model: c.model,
          interactionMode: c.interactionMode,
          ethAddress: c.ethAddress,
          pricePerWorkUnitWei: c.pricePerWorkUnitWei,
          workUnit: c.workUnit,
          unitsPerPrice: c.unitsPerPrice,
          quoteId: c.quoteId,
          quoteVersion: c.quoteVersion,
          constraintFingerprintHex: bytesToHex(c.constraintFingerprint),
          routeFingerprintHex: bytesToHex(c.routeFingerprint),
        })),
      };
    },
  );

  f.get(
    '/admin/registry/health',
    {
      schema: {
        tags: ['admin'],
        summary: 'Route-health tracker state',
        security: ADMIN_SECURITY,
        response: { 200: HealthResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => ({
      snapshots: deps.routeSelector.inspectHealth(),
      metrics: deps.routeSelector.inspectMetrics(),
    }),
  );

  f.get(
    '/admin/registry/models',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cached models table (active + inactive)',
        description:
          'What the background refresh task has written to the `models` table. ' +
          'Compare against `/admin/registry/candidates` to diagnose refresh lag.',
        security: ADMIN_SECURITY,
        response: { 200: ModelsResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const rows = await modelsRepo.listAll(deps.db);
      return {
        data: rows.map((r) => ({
          modelId: r.modelId,
          capability: r.capability,
          interactionMode: r.interactionMode,
          name: r.name,
          description: r.description,
          provider: r.provider,
          category: r.category,
          ethAddress: r.ethAddress,
          pricePerWorkUnitWei: r.pricePerWorkUnitWei,
          brokerUrl: r.brokerUrl,
          unitsPerPrice: r.unitsPerPrice,
          quoteId: r.quoteId,
          quoteVersion: r.quoteVersion,
          constraintFingerprintHex: r.constraintFingerprintHex,
          routeFingerprintHex: r.routeFingerprintHex,
          active: r.active,
          snapshotAt: r.snapshotAt,
        })),
      };
    },
  );
}

function bytesToHex(bytes: Uint8Array): string | null {
  return bytes.length > 0 ? Buffer.from(bytes).toString('hex') : null;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function summarizeByCapability(capabilities: string[]): Array<{ capability: string; count: number }> {
  const counts = new Map<string, number>();
  for (const capability of capabilities) {
    counts.set(capability, (counts.get(capability) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, count]) => ({ capability, count }));
}

function summarizeModelHealth(
  models: Array<{
    capability: string;
    category: string;
    selectable: boolean;
  }>,
): Array<{
  capability: string;
  category: string;
  availableModels: number;
  selectableModels: number;
  unavailableModels: number;
}> {
  const grouped = new Map<
    string,
    {
      capability: string;
      category: string;
      availableModels: number;
      selectableModels: number;
      unavailableModels: number;
    }
  >();
  for (const model of models) {
    const current = grouped.get(model.capability) ?? {
      capability: model.capability,
      category: model.category,
      availableModels: 0,
      selectableModels: 0,
      unavailableModels: 0,
    };
    current.availableModels += 1;
    if (model.selectable) current.selectableModels += 1;
    else current.unavailableModels += 1;
    grouped.set(model.capability, current);
  }
  return [...grouped.values()].sort((a, b) => a.category.localeCompare(b.category));
}
