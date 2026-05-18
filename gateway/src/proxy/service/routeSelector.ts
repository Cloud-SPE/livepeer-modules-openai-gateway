import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import type { FastifyRequest } from "fastify";

import type { Config } from "../../config.js";
import {
  inferInteractionMode,
  inferModel,
  type RegistryCatalog,
  type RouteCandidate,
} from "../../registry/catalog.js";
export type { RouteCandidate } from "../../registry/catalog.js";
import { HEADER } from "../livepeer/headers.js";
import { RouteHealthTracker, type RouteHealthMetrics, type RouteHealthSnapshot, type RouteOutcome } from "./routeHealth.js";

const RESOLVER_PROTO_FILES = [
  "livepeer/registry/v1/types.proto",
  "livepeer/registry/v1/resolver.proto",
];

export interface RouteSelectionInput {
  capability: string;
  offering: string;
  interactionMode?: string;
  request: FastifyRequest;
}

interface ResolverClient extends grpc.Client {
  selectMany(
    req: SelectRequest,
    cb: (err: grpc.ServiceError | null, resp: SelectManyResult) => void,
  ): void;
}

interface ResolverProto {
  livepeer: { registry: { v1: { Resolver: grpc.ServiceClientConstructor } } };
}

interface SelectRequest {
  capability: string;
  offering: string;
}

interface SelectManyResult {
  routes: SelectedRoute[];
}

interface SelectedRoute {
  workerUrl: string;
  ethAddress: string;
  capability: string;
  offering: string;
  pricePerWorkUnitWei: string;
  workUnit: string;
  unitsPerPrice: number;
  quoteId: string;
  quoteVersion: number;
  constraintFingerprint?: Buffer | Uint8Array | string;
  routeFingerprint?: Buffer | Uint8Array | string;
  extraJson?: Buffer | Uint8Array | string;
  constraintsJson?: Buffer | Uint8Array | string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface SelectionHints {
  preferredExtra: JsonValue | null;
  requiredConstraints: JsonValue | null;
  maxPricePerUnitWei: bigint | null;
}

interface PreferenceScore {
  fullMatch: boolean;
  matchedLeaves: number;
}

export interface RouteSelector {
  select(input: RouteSelectionInput): Promise<RouteCandidate[]>;
  recordOutcome(candidate: RouteCandidate, outcome: RouteOutcome, reason?: string): void;
  inspectHealth(): RouteHealthSnapshot[];
  inspectMetrics(): RouteHealthMetrics;
  close?(): Promise<void>;
}

export function createRouteSelector(cfg: Config, registryCatalog: RegistryCatalog): RouteSelector {
  const client = newResolverClient(cfg.resolverSocket, cfg.resolverProtoRoot);
  const health = new RouteHealthTracker({
    failureThreshold: Math.max(1, cfg.routeFailureThreshold),
    cooldownMs: Math.max(1_000, cfg.routeCooldownMs),
  });

  return {
    async select(input: RouteSelectionInput): Promise<RouteCandidate[]> {
      const hints = readSelectionHints(input.request);
      const selected = await selectCandidates(client, registryCatalog, input);
      const matches = selected.filter((candidate) => {
        if (input.interactionMode && candidate.interactionMode && candidate.interactionMode !== input.interactionMode) {
          return false;
        }
        if (
          hints.maxPricePerUnitWei !== null &&
          safeBigInt(candidate.pricePerWorkUnitWei) > hints.maxPricePerUnitWei
        ) {
          return false;
        }
        if (
          hints.requiredConstraints !== null &&
          !isSubset(candidate.constraints, hints.requiredConstraints)
        ) {
          return false;
        }
        return true;
      });

      sortByPreferredExtra(matches, hints.preferredExtra);
      return health.rankCandidates(matches);
    },
    recordOutcome(candidate: RouteCandidate, outcome: RouteOutcome, reason?: string): void {
      health.record(candidate, outcome, reason);
    },
    inspectHealth(): RouteHealthSnapshot[] {
      return health.inspect();
    },
    inspectMetrics(): RouteHealthMetrics {
      return health.inspectMetrics();
    },
    async close(): Promise<void> {
      client.close();
    },
  };
}

async function selectCandidates(
  client: ResolverClient,
  registryCatalog: RegistryCatalog,
  input: RouteSelectionInput,
): Promise<RouteCandidate[]> {
  try {
    const exact = await selectMany(client, input.capability, input.offering);
    if (exact.length > 0) return exact;
  } catch (err) {
    if (!isNoRoutesError(err)) throw err;
  }

  const aliasOfferings = await resolveModelOfferings(registryCatalog, input);
  if (aliasOfferings.length === 0) {
    throw new Error(`no route for capability=${input.capability} offering=${input.offering}`);
  }

  const selected = await Promise.all(
    aliasOfferings.map((offering) => selectMany(client, input.capability, offering)),
  );
  return selected.flat();
}

async function selectMany(
  client: ResolverClient,
  capability: string,
  offering: string,
): Promise<RouteCandidate[]> {
  const resp = await new Promise<SelectManyResult>((resolve, reject) => {
    client.selectMany(
      { capability, offering },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
  return (resp.routes ?? []).map(flattenSelectedRoute);
}

async function resolveModelOfferings(
  registryCatalog: RegistryCatalog,
  input: RouteSelectionInput,
): Promise<string[]> {
  const candidates = await registryCatalog.inspect();
  const matches = candidates.filter((candidate) => {
    if (candidate.capability !== input.capability) return false;
    if (candidate.model !== input.offering) return false;
    if (input.interactionMode && candidate.interactionMode !== input.interactionMode) return false;
    return true;
  });
  return [...new Set(matches.map((candidate) => candidate.offering).filter((offering) => offering.length > 0))];
}

function newResolverClient(socketPath: string, protoRoot: string): ResolverClient {
  const def = protoLoader.loadSync(RESOLVER_PROTO_FILES, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoRoot],
  });
  const proto = grpc.loadPackageDefinition(def) as unknown as ResolverProto;
  const ClientCtor = proto.livepeer.registry.v1.Resolver;
  return new ClientCtor(
    `unix:${socketPath}`,
    grpc.credentials.createInsecure(),
  ) as unknown as ResolverClient;
}

function flattenSelectedRoute(route: SelectedRoute): RouteCandidate {
  const extra = parseOpaqueJson(route.extraJson);
  return {
    brokerUrl: route.workerUrl,
    capability: route.capability,
    offering: route.offering,
    model: inferModel(route.capability, extra),
    interactionMode: inferInteractionMode(extra),
    ethAddress: route.ethAddress,
    pricePerWorkUnitWei: route.pricePerWorkUnitWei ?? "0",
    workUnit: route.workUnit ?? "",
    unitsPerPrice: Math.max(1, route.unitsPerPrice || 1),
    quoteId: route.quoteId ?? "",
    quoteVersion: route.quoteVersion ?? 0,
    constraintFingerprint: toBytes(route.constraintFingerprint),
    routeFingerprint: toBytes(route.routeFingerprint),
    extra,
    constraints: parseOpaqueJson(route.constraintsJson),
  };
}

function readSelectionHints(req: FastifyRequest): SelectionHints {
  return {
    preferredExtra: parseJsonHeader(req.headers[HEADER.SELECTOR_EXTRA.toLowerCase()]),
    requiredConstraints: parseJsonHeader(req.headers[HEADER.SELECTOR_CONSTRAINTS.toLowerCase()]),
    maxPricePerUnitWei: parseBigIntHeader(req.headers[HEADER.SELECTOR_MAX_PRICE_WEI.toLowerCase()]),
  };
}

function parseJsonHeader(value: string | string[] | undefined): JsonValue | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return JSON.parse(raw) as JsonValue;
}

function parseBigIntHeader(value: string | string[] | undefined): bigint | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return BigInt(raw);
}

function parseOpaqueJson(raw: Buffer | Uint8Array | string | undefined): JsonValue | null {
  if (!raw) return null;
  const text =
    typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (!text) return null;
  return JSON.parse(text) as JsonValue;
}

function isNoRoutesError(err: unknown): boolean {
  const anyErr = err as { code?: number; details?: string; message?: string };
  return anyErr?.code === grpc.status.NOT_FOUND
    || (anyErr?.details ?? "").includes("no selectable routes")
    || (anyErr?.message ?? "").includes("no selectable routes");
}

function compareCandidates(a: RouteCandidate, b: RouteCandidate, preferredExtra: JsonValue | null): number {
  const scoreA = scorePreference(a.extra, preferredExtra);
  const scoreB = scorePreference(b.extra, preferredExtra);
  if (scoreA.fullMatch !== scoreB.fullMatch) return scoreA.fullMatch ? -1 : 1;
  if (scoreA.matchedLeaves !== scoreB.matchedLeaves) return scoreB.matchedLeaves - scoreA.matchedLeaves;
  return 0;
}

function sortByPreferredExtra(candidates: RouteCandidate[], preferredExtra: JsonValue | null): void {
  if (preferredExtra === null || candidates.length < 2) return;
  candidates.sort((a, b) => compareCandidates(a, b, preferredExtra));
}

function scorePreference(candidate: JsonValue | null, preferred: JsonValue | null): PreferenceScore {
  if (preferred === null) return { fullMatch: true, matchedLeaves: 0 };
  const matchedLeaves = countMatchingLeaves(candidate, preferred);
  return {
    fullMatch: isSubset(candidate, preferred),
    matchedLeaves,
  };
}

function countMatchingLeaves(candidate: JsonValue | null, preferred: JsonValue): number {
  if (preferred === null || typeof preferred !== "object") {
    return deepEqual(candidate, preferred) ? 1 : 0;
  }
  if (Array.isArray(preferred)) {
    if (!Array.isArray(candidate)) return 0;
    return preferred.reduce<number>((sum, value) => {
      const found = candidate.some((candidateValue) => deepEqual(candidateValue, value));
      return sum + (found ? 1 : 0);
    }, 0);
  }

  if (!isJsonObject(candidate)) return 0;

  let matches = 0;
  for (const [key, value] of Object.entries(preferred)) {
    matches += countMatchingLeaves(candidate[key] ?? null, value);
  }
  return matches;
}

function isSubset(candidate: JsonValue | null, required: JsonValue): boolean {
  if (required === null || typeof required !== "object") {
    return deepEqual(candidate, required);
  }
  if (Array.isArray(required)) {
    if (!Array.isArray(candidate)) return false;
    return required.every((requiredValue) =>
      candidate.some((candidateValue) => deepEqual(candidateValue, requiredValue)),
    );
  }
  if (!isJsonObject(candidate)) return false;
  return Object.entries(required).every(([key, value]) => isSubset(candidate[key] ?? null, value));
}

function isJsonObject(value: JsonValue | null): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: JsonValue | null, b: JsonValue | null): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, idx) => deepEqual(value, b[idx] ?? null));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key, idx) => key === keysB[idx] && deepEqual(a[key], b[key]));
  }
  return false;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toBytes(raw: Buffer | Uint8Array | string | undefined): Uint8Array {
  if (!raw) return new Uint8Array();
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  return Uint8Array.from(raw);
}
