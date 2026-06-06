// Per-request model→route resolution against the (memoized) catalog.
//
// Users may request either the friendly model id (extra.openai.model,
// what /v1/models advertises) or a raw offering id. The LOC job wants
// the offering id; the runner wants its serving name in the JSON body.
// This helper maps between the three, preferring an offering whose
// advertised interaction mode matches what the route needs (so
// `stream:true` lands on a `-stream` offering without a mode-mismatch
// retry).
//
// Resolution is best-effort: when the catalog is unreachable or the
// LOC predates extra exposure, it falls back to the operator's
// LOC_MODEL_MAP and finally to the requested string itself — exactly
// the pre-dynamic behavior.

import type { RegistryCatalog, RouteCandidate } from '../registry/catalog.js';
import { inferModel } from '../registry/catalog.js';

export interface ResolvedRoute {
  /** Offering id to open the LOC job with. */
  offering: string;
  /** Model name to place in the upstream JSON body. */
  runnerModel: string;
}

export interface ResolveInput {
  catalog: RegistryCatalog;
  /** Operator override / fallback: offering id → runner model name. */
  modelMap: Record<string, string>;
  capability: string;
  requestedModel: string;
  interactionMode?: string;
}

export async function resolveRoute(input: ResolveInput): Promise<ResolvedRoute> {
  let candidates: RouteCandidate[] = [];
  try {
    candidates = await input.catalog.inspect();
  } catch {
    // Catalog unreachable — fall through to map/identity below; the
    // LOC job open will surface the real error if the LOC is down.
  }

  const matches = candidates.filter(
    (c) =>
      c.capability === input.capability &&
      (c.offering === input.requestedModel || c.model === input.requestedModel),
  );
  const pick =
    (input.interactionMode
      ? matches.find((c) => c.interactionMode === input.interactionMode)
      : undefined) ?? matches[0];

  const offering = pick?.offering ?? input.requestedModel;
  const runnerModel =
    (pick ? inferModel(pick.extra) : null) ??
    input.modelMap[offering] ??
    input.requestedModel;

  return { offering, runnerModel };
}
