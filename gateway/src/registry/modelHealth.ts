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
  interactionModes: string[];
  extra: Record<string, unknown> | null;
  snapshotAt: Date;
}

export async function loadActiveModelHealth(
  db: Db,
  registryCatalog: RegistryCatalog,
): Promise<ActiveModelHealth[]> {
  const [rows, liveCandidates] = await Promise.all([
    modelsRepo.listActive(db),
    registryCatalog.inspect(),
  ]);
  const liveIndex = indexCandidates(liveCandidates);

  return rows.map((row) => {
    const key = modelKey(row.capability, row.modelId);
    const matches = liveIndex.get(key) ?? [];
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
      interactionModes: uniq(
        matches
          .map((candidate) => candidate.interactionMode)
          .filter((mode): mode is string => typeof mode === 'string' && mode.length > 0),
      ),
      extra: isJsonObject(row.extraJson) ? row.extraJson : null,
      snapshotAt: row.snapshotAt,
    };
  });
}

function indexCandidates(candidates: RouteCandidate[]): Map<string, RouteCandidate[]> {
  const out = new Map<string, RouteCandidate[]>();
  for (const candidate of candidates) {
    const model = (candidate.model ?? candidate.offering)?.trim();
    if (!model) continue;
    const key = modelKey(candidate.capability, model);
    const bucket = out.get(key) ?? [];
    bucket.push(candidate);
    out.set(key, bucket);
  }
  return out;
}

function modelKey(capability: string, modelId: string): string {
  return `${capability}\u0000${modelId}`;
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
