// Registry catalog, LOC-backed: snapshots the clearinghouse's
// GET /v1/capabilities into the RouteCandidate shape the models
// refresh, admin surfaces, and per-request model resolution consume.
//
// With the LOC exposing the registry's merged `extra` metadata per
// offering, model identity is dynamic again: the user-facing model id
// is extra.openai.model (also the runner-facing serving name), falling
// back to the offering id when the metadata is absent. Interaction
// protocol and transports are required offering fields.
//
// inspect() memoizes for a short TTL — route handlers resolve
// model→offering on every request, and the snapshot only changes as
// fast as orchestrator manifests do.

import type {
  JobTransport,
  LocCapability,
  LocClient,
  LocWorkUnitEstimator,
} from '../loc/client.js';

export const PAID_JOB_PROTOCOL = 'paid-job/v1';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RouteCandidate {
  brokerUrl: string;
  capability: string;
  offering: string;
  model: string | null;
  protocol: typeof PAID_JOB_PROTOCOL;
  transports: JobTransport[];
  ethAddress: string;
  pricePerWorkUnitWei: string;
  workUnit: string;
  estimator?: LocWorkUnitEstimator;
  unitsPerPrice: number;
  quoteId: string;
  quoteVersion: number;
  constraintFingerprint: Uint8Array;
  routeFingerprint: Uint8Array;
  extra: JsonValue | null;
  constraints: JsonValue | null;
}

export interface RegistryCatalog {
  inspect(): Promise<RouteCandidate[]>;
  close?(): Promise<void>;
}

const INSPECT_TTL_MS = 15_000;

export function createRegistryCatalog(loc: LocClient): RegistryCatalog {
  let cached: { at: number; candidates: RouteCandidate[] } | null = null;

  return {
    async inspect(): Promise<RouteCandidate[]> {
      if (cached && Date.now() - cached.at < INSPECT_TTL_MS) {
        return cached.candidates;
      }
      const capabilities = await loc.listCapabilities();
      const candidates = flattenCapabilities(capabilities);
      cached = { at: Date.now(), candidates };
      return candidates;
    },
  };
}

/** Pure transform: LOC capabilities → RouteCandidate[]. Exported for
 * unit tests. */
export function flattenCapabilities(capabilities: LocCapability[]): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const capability of capabilities) {
    if (!capability.name) continue;
    for (const offering of capability.offerings) {
      if (!offering.id) continue;
      if (offering.protocol !== PAID_JOB_PROTOCOL) {
        // LOC serves a shared catalog. Session capabilities (for example the
        // Meetings pilot) are valid LOC entries but are outside this
        // paid-job-only gateway's product surface.
        if (offering.protocol) continue;
        throw new Error(`missing protocol for ${capability.name}/${offering.id}`);
      }
      if (offering.transports.length === 0) {
        throw new Error(`missing job transports for ${capability.name}/${offering.id}`);
      }
      const extra = normalizeExtra(offering.extra);
      out.push({
        brokerUrl: '',
        capability: capability.name,
        offering: offering.id,
        model: inferModel(extra) ?? offering.id,
        protocol: PAID_JOB_PROTOCOL,
        transports: [...offering.transports],
        ethAddress: '',
        pricePerWorkUnitWei: offering.pricePerWorkUnitWei ?? '0',
        workUnit: offering.workUnit ?? capability.workUnit ?? '',
        ...(offering.estimator ? { estimator: { ...offering.estimator } } : {}),
        unitsPerPrice: offering.unitsPerPrice,
        quoteId: '',
        quoteVersion: 0,
        constraintFingerprint: new Uint8Array(),
        routeFingerprint: new Uint8Array(),
        extra,
        constraints: null,
      });
    }
  }
  return out;
}

/** The runner-facing serving name advertised by the orchestrator —
 * extra.openai.model. Null when the metadata is absent (pre-extra LOC
 * or non-OpenAI capability). */
export function inferModel(extra: JsonValue | null): string | null {
  if (!isJsonObject(extra)) return null;
  const openai = extra['openai'];
  if (!isJsonObject(openai)) return null;
  const model = openai['model'];
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
}

function normalizeExtra(raw: Record<string, unknown>): JsonValue | null {
  return Object.keys(raw).length > 0 ? (raw as JsonValue) : null;
}

function isJsonObject(value: JsonValue | null | undefined): value is { [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}
