import * as modelsRepo from '../repo/models.js';
import type { Db } from '../db.js';
import type { RegistryCatalog, RouteCandidate } from './catalog.js';

export interface ActiveModelHealth {
  id: string;
  capability: string;
  category: string;
  provider: string | null;
  name: string | null;
  description: string | null;
  selectable: boolean;
  reason: string | null;
  routeCount: number;
  offerings: string[];
  protocol: string;
  transports: string[];
  extra: Record<string, unknown> | null;
  snapshotAt: Date;
}

export async function loadActiveModelHealth(
  db: Db,
  registryCatalog: RegistryCatalog,
): Promise<ActiveModelHealth[]> {
  const [rows, snapshot] = await Promise.all([
    modelsRepo.listActive(db),
    registryCatalog.inspect(),
  ]);

  return rows.map((row) => {
    const matches = candidatesForModel(snapshot.candidates, row.capability, row.modelId);
    return {
      id: row.modelId,
      capability: row.capability,
      category: capabilityCategory(row.capability),
      provider: row.provider,
      name: row.name,
      description: row.description,
      selectable: matches.length > 0,
      reason: matches.length > 0 ? null : 'no_routes',
      routeCount: matches.length,
      offerings: uniq(matches.map((candidate) => candidate.offering)),
      protocol: row.protocol,
      transports: uniq(matches.flatMap((candidate) => candidate.transports)),
      extra: isJsonObject(row.extraJson) ? row.extraJson : null,
      snapshotAt: row.snapshotAt,
    };
  });
}

export function candidatesForModel(
  candidates: RouteCandidate[],
  capability: string,
  offering: string,
): RouteCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.capability === capability && candidate.offering.trim() === offering,
  );
}

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function capabilityCategory(capability: string): string {
  switch (capability) {
    case 'openai:chat-completions':
      return 'chat';
    case 'openai:embeddings':
      return 'embeddings';
    case 'openai:images-generations':
      return 'images';
    case 'openai:audio-speech':
      return 'speech';
    case 'openai:audio-transcriptions':
      return 'transcriptions';
    case 'rerank':
      return 'rerank';
    default:
      return 'other';
  }
}
