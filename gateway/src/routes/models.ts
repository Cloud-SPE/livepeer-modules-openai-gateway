// GET /v1/models — OpenAI-shaped catalog endpoint.
//
// Reads from the `models` table, which the registry refresh task
// populates from the on-chain service registry. No hardcoded list.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import * as modelsRepo from '../repo/models.js';

const MIN_MODELS_CACHE_AGE_MS = 120_000;

export async function registerModelsRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.get('/v1/models', async (_req, reply) => {
    const rows = await modelsRepo.listAll(deps.db);
    const maxAgeMs = Math.max(deps.config.registryRefreshIntervalMs * 2, MIN_MODELS_CACHE_AGE_MS);
    const latestSnapshotAt = rows.reduce<Date | null>((latest, row) => {
      if (!latest || row.snapshotAt > latest) return row.snapshotAt;
      return latest;
    }, null);
    if (!latestSnapshotAt) {
      return reply.code(503).send({
        error: {
          message: 'models cache unavailable',
          type: 'api_error',
          code: 'models_cache_unavailable',
        },
      });
    }
    const ageMs = Date.now() - latestSnapshotAt.getTime();
    if (ageMs > maxAgeMs) {
      return reply.code(503).send({
        error: {
          message: 'models cache stale',
          type: 'api_error',
          code: 'models_cache_stale',
        },
      });
    }
    const activeRows = rows.filter((row) => row.active);
    return {
      object: 'list',
      data: activeRows.map((r) => ({
        id: r.modelId,
        object: 'model',
        created: Math.floor(r.snapshotAt.getTime() / 1000),
        owned_by: r.provider ?? 'livepeer',
      })),
    };
  });
}
