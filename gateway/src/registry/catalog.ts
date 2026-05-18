import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type { Config } from '../config.js';

const RESOLVER_PROTO_FILES = [
  'livepeer/registry/v1/types.proto',
  'livepeer/registry/v1/resolver.proto',
];

export interface RouteCandidate {
  brokerUrl: string;
  capability: string;
  offering: string;
  model: string | null;
  interactionMode: string | null;
  ethAddress: string;
  pricePerWorkUnitWei: string;
  workUnit: string;
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

interface ResolverClient extends grpc.Client {
  listKnown(
    req: Record<string, never>,
    cb: (err: grpc.ServiceError | null, resp: ListKnownResult) => void,
  ): void;
  resolveByAddress(
    req: ResolveByAddressRequest,
    cb: (err: grpc.ServiceError | null, resp: ResolveResult) => void,
  ): void;
}

interface ResolverProto {
  livepeer: { registry: { v1: { Resolver: grpc.ServiceClientConstructor } } };
}

interface ListKnownResult {
  entries: KnownEntry[];
}

interface KnownEntry {
  ethAddress: string;
}

interface ResolveByAddressRequest {
  ethAddress: string;
  allowUnsigned: boolean;
  forceRefresh: boolean;
}

interface ResolveResult {
  nodes: ResolverNode[];
}

interface ResolverNode {
  url: string;
  operatorAddress: string;
  enabled: boolean;
  extraJson?: Buffer | Uint8Array | string;
  capabilities: ResolverCapability[];
}

interface ResolverCapability {
  name: string;
  workUnit: string;
  extraJson?: Buffer | Uint8Array | string;
  offerings: ResolverOffering[];
}

interface ResolverOffering {
  id: string;
  pricePerWorkUnitWei: string;
  constraintsJson?: Buffer | Uint8Array | string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function createRegistryCatalog(cfg: Config): RegistryCatalog {
  const client = newResolverClient(cfg.resolverSocket, cfg.resolverProtoRoot);

  return {
    async inspect(): Promise<RouteCandidate[]> {
      return loadSnapshot(client);
    },
    async close(): Promise<void> {
      client.close();
    },
  };
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

async function loadSnapshot(
  client: ResolverClient,
): Promise<RouteCandidate[]> {
  const known = await new Promise<KnownEntry[]>((resolve, reject) => {
    client.listKnown({}, (err, resp) => (err ? reject(err) : resolve(resp.entries ?? [])));
  });

  const resolved = await Promise.allSettled(
    known.map(
      (entry) =>
        new Promise<ResolveResult>((resolve, reject) => {
          client.resolveByAddress(
            {
              ethAddress: entry.ethAddress,
              allowUnsigned: false,
              forceRefresh: false,
            },
            (err, resp) => (err ? reject(err) : resolve(resp)),
          );
        }),
    ),
  );

  return collectResolvedResults(resolved).flatMap(flattenResolveResult);
}

export function collectResolvedResults(
  results: PromiseSettledResult<ResolveResult>[],
): ResolveResult[] {
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

export function flattenResolveResult(resolved: ResolveResult): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const node of resolved.nodes ?? []) {
    if (!node.enabled || !node.url) continue;
    const nodeExtra = parseOpaqueJson(node.extraJson);
    for (const capability of node.capabilities ?? []) {
      const mergedExtra = mergeJsonObjects(nodeExtra, parseOpaqueJson(capability.extraJson));
      const model = inferModel(capability.name, mergedExtra);
      for (const offering of capability.offerings ?? []) {
        out.push({
          brokerUrl: node.url,
          capability: stripCapabilityModelSuffix(capability.name),
          offering: offering.id,
          model,
          interactionMode: inferInteractionMode(mergedExtra),
          ethAddress: node.operatorAddress,
          pricePerWorkUnitWei: offering.pricePerWorkUnitWei ?? '0',
          workUnit: capability.workUnit ?? '',
          unitsPerPrice: 1,
          quoteId: '',
          quoteVersion: 0,
          constraintFingerprint: emptyConstraintFingerprint(),
          routeFingerprint: new Uint8Array(),
          extra: mergedExtra,
          constraints: parseOpaqueJson(offering.constraintsJson),
        });
      }
    }
  }
  return out;
}

export function inferModel(capabilityName: string, extra: JsonValue | null): string | null {
  if (isJsonObject(extra) && isJsonObject(extra.openai)) {
    const model = extra.openai['model'];
    if (typeof model === 'string' && model.trim().length > 0) return model.trim();
  }
  const suffix = capabilityModelSuffix(capabilityName);
  return suffix || null;
}

export function inferInteractionMode(extra: JsonValue | null): string | null {
  if (!isJsonObject(extra)) return null;
  const mode = extra['interaction_mode'];
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

function stripCapabilityModelSuffix(capabilityName: string): string {
  const suffix = capabilityModelSuffix(capabilityName);
  if (!suffix) return capabilityName;
  return capabilityName.slice(0, -(suffix.length + 1));
}

function capabilityModelSuffix(capabilityName: string): string {
  for (const prefix of [
    'openai:chat-completions:',
    'openai:embeddings:',
    'openai:audio-transcriptions:',
    'openai:audio-speech:',
    'openai:images-generations:',
    'openai:realtime:',
  ]) {
    if (capabilityName.startsWith(prefix)) {
      return capabilityName.slice(prefix.length).trim();
    }
  }
  return '';
}

function parseOpaqueJson(raw: Buffer | Uint8Array | string | undefined): JsonValue | null {
  if (!raw) return null;
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (!text) return null;
  return JSON.parse(text) as JsonValue;
}

function mergeJsonObjects(a: JsonValue | null, b: JsonValue | null): JsonValue | null {
  if (!isJsonObject(a)) return b;
  if (!isJsonObject(b)) return a;
  return { ...a, ...b };
}

function isJsonObject(value: JsonValue | null): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyConstraintFingerprint(): Uint8Array {
  return new Uint8Array();
}
