// Reservation lifecycle helpers. Each /v1/* route calls these around
// its dispatch — open → dispatch → commit | refund.
//
// In v1 there's no billing math: open writes state='open', commit writes
// state='committed' with observed work_units, refund writes
// state='refunded' with the error text. Forward-compat with future
// billing: the state machine + numeric fields are already in the schema.

import { randomUUID } from 'node:crypto';

import type { ServerDeps } from '../server.js';
import * as usageRepo from '../repo/usageReservations.js';
import { proxyReservationsTotal } from '../metrics.js';
import type { RouteCandidate } from '../loc/dispatch.js';

export interface OpenReservationInput {
  apiKeyId: string;
  capability: string;
  model: string;
  estimatedWorkUnits: number | null;
}

export interface ReservationHandle {
  workId: string;
  startedAt: number;
  capability: string;
}

export async function openReservation(
  deps: ServerDeps,
  input: OpenReservationInput,
): Promise<ReservationHandle> {
  const workId = randomUUID();
  await usageRepo.open(deps.db, {
    workId,
    apiKeyId: input.apiKeyId,
    capability: input.capability,
    model: input.model,
    brokerUrl: null,
    ethAddress: null,
    selectedCapability: null,
    selectedOffering: null,
    selectedWorkUnit: null,
    unitsPerPrice: null,
    quoteId: null,
    quoteVersion: null,
    constraintFingerprintHex: null,
    routeFingerprintHex: null,
    estimatedWorkUnits: input.estimatedWorkUnits,
    committedWorkUnits: null,
    pricePerWorkUnitWei: null,
    latencyMs: null,
    statusCode: null,
    errorText: null,
    resolvedAt: null,
  });
  proxyReservationsTotal.inc({ capability: input.capability, outcome: 'opened' });
  return { workId, startedAt: Date.now(), capability: input.capability };
}

export interface CommitInput {
  workUnits: number | null;
  statusCode: number;
  /** LOC job to settle with the observed units. The same DB write that
   * commits the reservation enqueues the durable settle (settler.ts). */
  locJobId?: string | null;
}

export async function commitReservation(
  deps: ServerDeps,
  handle: ReservationHandle,
  input: CommitInput,
): Promise<void> {
  await usageRepo.commit(deps.db, {
    workId: handle.workId,
    committedWorkUnits: input.workUnits,
    latencyMs: Date.now() - handle.startedAt,
    statusCode: input.statusCode,
    locJobId: input.locJobId ?? null,
  });
  proxyReservationsTotal.inc({ capability: handle.capability, outcome: 'committed' });
}

export interface RefundInput {
  statusCode: number;
  errorText: string;
  /** LOC job to settle with 0 units — full refund of the estimate. */
  locJobId?: string | null;
}

export async function refundReservation(
  deps: ServerDeps,
  handle: ReservationHandle,
  input: RefundInput,
): Promise<void> {
  await usageRepo.refund(deps.db, {
    workId: handle.workId,
    latencyMs: Date.now() - handle.startedAt,
    statusCode: input.statusCode,
    errorText: input.errorText,
    locJobId: input.locJobId ?? null,
  });
  proxyReservationsTotal.inc({ capability: handle.capability, outcome: 'refunded' });
}

export async function recordSelectedRoute(
  deps: ServerDeps,
  handle: ReservationHandle,
  candidate: RouteCandidate,
): Promise<void> {
  await usageRepo.updateRouteMetadata(deps.db, {
    workId: handle.workId,
    brokerUrl: candidate.brokerUrl || null,
    ethAddress: candidate.ethAddress || null,
    selectedCapability: candidate.capability || null,
    selectedOffering: candidate.offering || null,
    selectedWorkUnit: candidate.workUnit || null,
    unitsPerPrice: candidate.unitsPerPrice || null,
    pricePerWorkUnitWei: candidate.pricePerWorkUnitWei || null,
    quoteId: candidate.quoteId || null,
    quoteVersion: String(candidate.quoteVersion ?? 0),
    constraintFingerprintHex: bytesToHex(candidate.constraintFingerprint),
    routeFingerprintHex: bytesToHex(candidate.routeFingerprint),
  });
}

function bytesToHex(bytes: Uint8Array): string | null {
  return bytes.length > 0 ? Buffer.from(bytes).toString('hex') : null;
}
