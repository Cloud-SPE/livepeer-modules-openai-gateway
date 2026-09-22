// Per-request model→route resolution against the (memoized) catalog.
//
// Users may request either the friendly model id (extra.openai.model,
// what /v1/models advertises) or a raw offering id. The LOC job wants
// the offering id; the runner wants its serving name in the JSON body.
// This helper maps the LOC offering id to the runner-facing model and
// verifies that the same offering declares the requested transport.
//
// Resolution is best-effort for ordinary JSON workloads. An endpoint that
// requires a reproducible client estimator fails closed when the catalog is
// unavailable or the offering does not advertise the exact supported contract.

import type { RegistryCatalog, RouteCandidate } from '../registry/catalog.js';
import { inferModel } from '../registry/catalog.js';
import type { JobTransport } from './client.js';

export type RequiredEstimatorContract = Pick<
  import('./client.js').LocWorkUnitEstimator,
  'id' | 'rounding' | 'exactness'
>;

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
  transport: JobTransport;
  expectedWorkUnit?: string | readonly string[];
  expectedEstimator?: RequiredEstimatorContract;
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
      c.offering === input.requestedModel,
  );
  const pick = matches.find((c) => c.transports.includes(input.transport));
  const expectedUnits = typeof input.expectedWorkUnit === 'string' ? [input.expectedWorkUnit] : input.expectedWorkUnit;
  if (pick && expectedUnits && !expectedUnits.includes(pick.workUnit)) {
    throw new Error(
      `offering ${pick.offering} uses work unit ${pick.workUnit}; expected ${input.expectedWorkUnit}`,
    );
  }
  if (input.expectedEstimator) {
    if (!pick) {
      throw new Error(
        `offering ${input.requestedModel} cannot be funded without catalog estimator metadata`,
      );
    }
    const actual = pick.estimator;
    const expected = input.expectedEstimator;
    if (
      !actual ||
      actual.id !== expected.id ||
      actual.rounding !== expected.rounding ||
      actual.exactness !== expected.exactness
    ) {
      throw new Error(
        `offering ${pick.offering} does not advertise the required ${expected.id} estimator contract`,
      );
    }
  }

  const offering = pick?.offering ?? input.requestedModel;
  const runnerModel =
    (pick ? inferModel(pick.extra) : null) ??
    input.modelMap[offering] ??
    input.requestedModel;

  return { offering, runnerModel };
}
