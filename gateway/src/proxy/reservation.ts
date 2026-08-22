// Gateway request-observation lifecycle. Each /v1/* route records open,
// dispatch, and the customer-visible outcome. These rows are operational
// telemetry only; signed broker evidence is the sole LOC accounting input.

import { randomUUID } from 'node:crypto';

import type { ServerDeps } from '../server.js';
import * as usageRepo from '../repo/usageReservations.js';
import { proxyReservationsTotal } from '../metrics.js';
import type { JobRef, RouteCandidate } from '../loc/dispatch.js';

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
  });
  proxyReservationsTotal.inc({ capability: handle.capability, outcome: 'committed' });
}

export interface RefundInput {
  statusCode: number;
  errorText: string;
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

/** Dispatch calls this immediately after the idempotent LOC open and
 * again once broker admission reveals Livepeer-Job-Id. */
export async function recordPaidJob(
  deps: ServerDeps,
  handle: ReservationHandle,
  job: JobRef,
  candidate: RouteCandidate,
): Promise<void> {
  await usageRepo.recordPaidJobIdentity(deps.db, {
    workId: handle.workId,
    locIdempotencyKey: job.idempotencyKey,
    locJobId: job.jobId,
    locRequestId: job.requestId,
    paymentWorkId: job.workId,
    brokerJobId: job.brokerJobId || null,
    protocol: job.protocol,
    transport: job.transport,
    workUnit: job.workUnit,
    settleEndpoint: job.settleEndpoint,
    brokerUrl: job.brokerUrl,
    selectedCapability: job.capability,
    selectedOffering: job.offering,
    unitsPerPrice: candidate.unitsPerPrice || null,
    pricePerWorkUnitWei: candidate.pricePerWorkUnitWei || null,
  });
}

function bytesToHex(bytes: Uint8Array): string | null {
  return bytes.length > 0 ? Buffer.from(bytes).toString('hex') : null;
}
