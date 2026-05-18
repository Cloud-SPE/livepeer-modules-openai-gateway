// Portal playground support: expose richer active-model metadata than the
// public `/v1/models` shape so the portal can show enabled/disabled features.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { loadActiveModelHealth } from '../../registry/modelHealth.js';
import { ErrorBody } from '../../schema/api.js';
import { requirePortalSession } from './auth.js';

const SpeechVoices = z.object({
  aliases: z.record(z.string(), z.string()).optional(),
  native: z.array(z.string()).optional(),
  default: z.string().optional(),
});

const PlaygroundModel = z.object({
  id: z.string(),
  capability: z.string(),
  category: z.string(),
  provider: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  selectable: z.boolean(),
  routeCount: z.number(),
  offerings: z.array(z.string()),
  interactionModes: z.array(z.string()),
  voices: SpeechVoices.nullable(),
  reason: z.string().nullable(),
  snapshotAt: z.union([z.string().datetime(), z.date()]),
});

const PlaygroundCatalogResponse = z
  .object({
    data: z.array(PlaygroundModel),
  })
  .meta({ id: 'PortalPlaygroundCatalog' });

export async function registerPlaygroundRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/portal/playground/catalog',
    {
      schema: {
        tags: ['portal'],
        summary: 'Portal playground model catalog',
        description:
          'Richer active-model metadata for the portal playground, grouped by capability.',
        security: [{ cookieAuth: [] }],
        response: { 200: PlaygroundCatalogResponse, 401: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async () => {
      const rows = await loadActiveModelHealth(deps.db, deps.registryCatalog);
      return {
        data: rows.map((row) => ({
          id: row.id,
          capability: row.capability,
          category: row.category,
          provider: row.provider,
          name: row.name,
          description: row.description,
          selectable: row.selectable,
          routeCount: row.routeCount,
          offerings: row.offerings,
          interactionModes: row.interactionModes,
          voices: extractVoices(row.extra),
          reason: row.reason,
          snapshotAt: row.snapshotAt,
        })),
      };
    },
  );
}

function extractVoices(extra: Record<string, unknown> | null): z.infer<typeof SpeechVoices> | null {
  const rootVoices = asRecord(extra?.voices);
  const audioVoices = asRecord(asRecord(extra?.audio)?.voices);
  const source = rootVoices ?? audioVoices;
  if (!source) return null;
  return {
    aliases: asStringRecord(source.aliases),
    native: asStringArray(source.native),
    default: typeof source.default === 'string' ? source.default : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out = Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out.length > 0 ? out : undefined;
}
