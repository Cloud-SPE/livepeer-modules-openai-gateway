import { and, desc, eq, gt, sql } from 'drizzle-orm';

import type { Db } from '../db.js';
import {
  apiKeys,
  usageReservations,
  waitlist,
  type UsageReservation,
  type NewUsageReservation,
} from '../schema/index.js';

export type NewReservation = Omit<NewUsageReservation, 'id' | 'createdAt' | 'state'>;

export async function open(
  db: Db,
  input: NewReservation,
): Promise<UsageReservation> {
  const [row] = await db
    .insert(usageReservations)
    .values({ ...input, state: 'open' })
    .returning();
  return row!;
}

export interface CommitInput {
  workId: string;
  committedWorkUnits: number | null;
  latencyMs: number;
  statusCode: number;
}

export async function commit(db: Db, input: CommitInput): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      state: 'committed',
      committedWorkUnits: input.committedWorkUnits,
      latencyMs: input.latencyMs,
      statusCode: input.statusCode,
      resolvedAt: new Date(),
    })
    .where(eq(usageReservations.workId, input.workId));
}

export interface RouteMetadataUpdate {
  workId: string;
  brokerUrl: string | null;
  ethAddress: string | null;
  selectedCapability: string | null;
  selectedOffering: string | null;
  selectedWorkUnit: string | null;
  unitsPerPrice: number | null;
  pricePerWorkUnitWei: string | null;
  quoteId: string | null;
  quoteVersion: string | null;
  constraintFingerprintHex: string | null;
  routeFingerprintHex: string | null;
}

export async function updateRouteMetadata(
  db: Db,
  input: RouteMetadataUpdate,
): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      brokerUrl: input.brokerUrl,
      ethAddress: input.ethAddress,
      selectedCapability: input.selectedCapability,
      selectedOffering: input.selectedOffering,
      selectedWorkUnit: input.selectedWorkUnit,
      unitsPerPrice: input.unitsPerPrice,
      pricePerWorkUnitWei: input.pricePerWorkUnitWei,
      quoteId: input.quoteId,
      quoteVersion: input.quoteVersion,
      constraintFingerprintHex: input.constraintFingerprintHex,
      routeFingerprintHex: input.routeFingerprintHex,
    })
    .where(eq(usageReservations.workId, input.workId));
}

export interface PaidJobIdentityInput {
  workId: string;
  locIdempotencyKey: string;
  locJobId: string;
  locRequestId: string;
  paymentWorkId: string;
  brokerJobId: string | null;
  protocol: 'paid-job/v1';
  transport: 'unary' | 'stream' | 'multipart';
  workUnit: string;
  settleEndpoint: string;
  brokerUrl: string;
  selectedCapability: string;
  selectedOffering: string;
  unitsPerPrice: number | null;
  pricePerWorkUnitWei: string | null;
}

/** Persist every paid-job identity before asynchronous recovery starts. */
export async function recordPaidJobIdentity(
  db: Db,
  input: PaidJobIdentityInput,
): Promise<void> {
  const [row] = await db
    .update(usageReservations)
    .set({
      locIdempotencyKey: input.locIdempotencyKey,
      locJobId: input.locJobId,
      locRequestId: input.locRequestId,
      paymentWorkId: input.paymentWorkId,
      brokerJobId: input.brokerJobId,
      jobProtocol: input.protocol,
      jobTransport: input.transport,
      selectedWorkUnit: input.workUnit,
      settleEndpoint: input.settleEndpoint,
      brokerUrl: input.brokerUrl,
      selectedCapability: input.selectedCapability,
      selectedOffering: input.selectedOffering,
      unitsPerPrice: input.unitsPerPrice,
      pricePerWorkUnitWei: input.pricePerWorkUnitWei,
      settlementLookupState: 'pending',
      settlementLookupNextAt: new Date(),
      settlementLookupUpdatedAt: new Date(),
      settlementLookupLastError: null,
    })
    .where(eq(usageReservations.workId, input.workId))
    .returning({ id: usageReservations.id });
  if (!row) throw new Error(`reservation ${input.workId} not found`);
}

export type SettlementLookupState =
  | 'pending'
  | 'accounting_pending'
  | 'in_flight'
  | 'ready'
  | 'not_admitted'
  | 'no_record'
  | 'evidence_expired'
  | 'failed';

export interface PendingSettlementLookup {
  id: string;
  brokerUrl: string;
  brokerJobId: string | null;
  locRequestId: string;
  paymentWorkId: string;
  workUnit: string;
  attempts: number;
}

/** Read-only broker lookups are safe to duplicate across replicas. */
export async function claimPendingSettlementLookups(
  db: Db,
  limit: number,
): Promise<PendingSettlementLookup[]> {
  const rows = await db.execute(sql`
    SELECT id, broker_url, broker_job_id, loc_request_id, payment_work_id,
           selected_work_unit, settlement_lookup_attempts
    FROM usage_reservations
    WHERE settlement_lookup_state IN ('pending', 'accounting_pending', 'in_flight')
      AND settlement_lookup_next_at <= now()
      AND broker_url IS NOT NULL
      AND loc_request_id IS NOT NULL
      AND payment_work_id IS NOT NULL
      AND selected_work_unit IS NOT NULL
    ORDER BY settlement_lookup_next_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);
  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: requiredText(r, 'id'),
      brokerUrl: requiredText(r, 'broker_url'),
      brokerJobId: optionalText(r, 'broker_job_id'),
      locRequestId: requiredText(r, 'loc_request_id'),
      paymentWorkId: requiredText(r, 'payment_work_id'),
      workUnit: requiredText(r, 'selected_work_unit'),
      attempts: requiredNonnegativeInteger(r, 'settlement_lookup_attempts'),
    };
  });
}

export async function deferSettlementLookup(
  db: Db,
  id: string,
  state: 'pending' | 'accounting_pending' | 'in_flight' | 'no_record',
  nextAt: Date,
  detail: string | null,
): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      settlementLookupState: state,
      settlementLookupAttempts: sql`${usageReservations.settlementLookupAttempts} + 1`,
      settlementLookupNextAt: nextAt,
      settlementLookupUpdatedAt: new Date(),
      settlementLookupLastError: detail?.slice(0, 500) ?? null,
    })
    .where(eq(usageReservations.id, id));
}

export interface SettlementEvidenceIdentity {
  requestId: string;
  brokerJobId: string | null;
  paymentWorkId: string;
  workUnit: string;
}

export interface SettlementEvidence extends Omit<SettlementEvidenceIdentity, 'brokerJobId'> {
  brokerJobId: string;
  encoded: string;
  envelope: Record<string, unknown>;
  actualUnits: string;
  debitedUnits: string;
  billedValueWei: string;
  outcome: string;
}

export class SettlementEvidenceDriftError extends Error {
  constructor(readonly differences: string[]) {
    super(`settlement evidence identity drift: ${differences.join('; ')}`);
    this.name = 'SettlementEvidenceDriftError';
  }
}

export function validateSettlementEvidenceIdentity(
  expected: SettlementEvidenceIdentity,
  actual: SettlementEvidenceIdentity,
): string[] {
  const differences: string[] = [];
  for (const field of ['requestId', 'brokerJobId', 'paymentWorkId', 'workUnit'] as const) {
    // A response can be lost after admission, so brokerJobId is learned
    // from the signed request-id lookup when it was not observed inline.
    if (field === 'brokerJobId' && expected[field] === null) continue;
    if (expected[field] !== actual[field]) {
      differences.push(`${field}: expected ${expected[field]}, received ${actual[field]}`);
    }
  }
  return differences;
}

/** Store the complete signed claim only when all persisted identities agree.
 * Drift is durably marked failed before the caller receives the error. */
export async function recordSettlementEvidence(
  db: Db,
  id: string,
  evidence: SettlementEvidence,
): Promise<void> {
  for (const [name, value] of [
    ['actualUnits', evidence.actualUnits],
    ['debitedUnits', evidence.debitedUnits],
    ['billedValueWei', evidence.billedValueWei],
  ] as const) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`${name} must be an unsigned base-10 integer string`);
    }
  }

  const drift = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        requestId: usageReservations.locRequestId,
        brokerJobId: usageReservations.brokerJobId,
        paymentWorkId: usageReservations.paymentWorkId,
        workUnit: usageReservations.selectedWorkUnit,
      })
      .from(usageReservations)
      .where(eq(usageReservations.id, id))
      .for('update');
    if (!row) return [`reservation: ${id} not found`];
    const expected: SettlementEvidenceIdentity = {
      requestId: row.requestId ?? '<missing>',
      brokerJobId: row.brokerJobId,
      paymentWorkId: row.paymentWorkId ?? '<missing>',
      workUnit: row.workUnit ?? '<missing>',
    };
    const differences = validateSettlementEvidenceIdentity(expected, evidence);
    if (differences.length > 0) {
      await tx
        .update(usageReservations)
        .set({
          settlementLookupState: 'failed',
          settlementLookupUpdatedAt: new Date(),
          settlementLookupLastError: `identity drift: ${differences.join('; ')}`.slice(0, 500),
        })
        .where(eq(usageReservations.id, id));
      return differences;
    }
    await tx
      .update(usageReservations)
      .set({
        settlementLookupState: evidence.outcome === 'DEBIT_FAILED' ? 'failed' : 'ready',
        settlementLookupUpdatedAt: new Date(),
        settlementLookupLastError:
          evidence.outcome === 'DEBIT_FAILED'
            ? 'signed DEBIT_FAILED: broker delivery completed without terminal debit'
            : null,
        brokerJobId: evidence.brokerJobId,
        settlementEncoded: evidence.encoded,
        settlementEnvelope: evidence.envelope,
        settlementCapturedAt: new Date(),
        brokerActualUnits: evidence.actualUnits,
        brokerDebitedUnits: evidence.debitedUnits,
        brokerBilledValueWei: evidence.billedValueWei,
        brokerSettlementOutcome: evidence.outcome,
        terminalEvidenceType: evidence.outcome === 'DEBIT_FAILED' ? 'debit_failed' : null,
        terminalEvidenceEncoded: evidence.outcome === 'DEBIT_FAILED' ? evidence.encoded : null,
        settleState: evidence.outcome === 'DEBIT_FAILED' ? null : 'pending',
      })
      .where(eq(usageReservations.id, id));
    return [];
  });
  if (drift.length > 0) throw new SettlementEvidenceDriftError(drift);
}

export async function recordSettlementLookupTerminal(
  db: Db,
  id: string,
  state: 'not_admitted' | 'evidence_expired' | 'failed',
  detail: string,
  encodedEvidence: string | null = null,
): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      settlementLookupState: state,
      settlementLookupAttempts: sql`${usageReservations.settlementLookupAttempts} + 1`,
      settlementLookupNextAt: null,
      settlementLookupUpdatedAt: new Date(),
      settlementLookupLastError: detail.slice(0, 500),
      terminalEvidenceType:
        state === 'not_admitted' ? 'not_admitted' : state === 'evidence_expired' ? 'evidence_expired' : null,
      terminalEvidenceEncoded: encodedEvidence,
    })
    .where(eq(usageReservations.id, id));
}

export async function recordGatewayObservation(
  db: Db,
  workId: string,
  units: string | null,
  source: string | null,
): Promise<void> {
  if (units !== null && !/^(0|[1-9][0-9]*)$/.test(units)) {
    throw new Error('gateway observed units must be an unsigned base-10 integer string');
  }
  await db
    .update(usageReservations)
    .set({ gatewayObservedUnits: units, gatewayObservationSource: source })
    .where(eq(usageReservations.workId, workId));
}

function requiredText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${field} in settlement lookup row`);
  }
  return value;
}

function optionalText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${field} in settlement lookup row`);
  }
  return value;
}

function requiredNonnegativeInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  const parsed = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${field} in settlement lookup row`);
  }
  return parsed;
}

export interface RefundInput {
  workId: string;
  latencyMs: number;
  statusCode: number;
  errorText: string;
}

export async function refund(db: Db, input: RefundInput): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      state: 'refunded',
      latencyMs: input.latencyMs,
      statusCode: input.statusCode,
      errorText: input.errorText,
      resolvedAt: new Date(),
    })
    .where(eq(usageReservations.workId, input.workId));
}

// ── settle queue (consumed by loc/settler.ts) ───────────────────────

export interface PendingSettlement {
  id: string;
  locJobId: string;
  brokerJobId: string;
  workUnit: string;
  actualUnits: number;
  outcome: string;
  settlement: Record<string, unknown>;
  settleAttempts: number;
}

/** Claim a batch of pending settlements. FOR UPDATE SKIP LOCKED keeps
 * this safe if a second gateway replica ever runs the settler too. */
export async function claimPendingSettlements(
  db: Db,
  limit: number,
): Promise<PendingSettlement[]> {
  const rows = await db.execute(sql`
    SELECT id, loc_job_id, broker_job_id, selected_work_unit,
           broker_actual_units, broker_settlement_outcome,
           settlement_envelope, settle_attempts
    FROM usage_reservations
    WHERE settle_state = 'pending'
      AND settlement_lookup_state = 'ready'
      AND loc_job_id IS NOT NULL
      AND broker_job_id IS NOT NULL
      AND selected_work_unit IS NOT NULL
      AND broker_actual_units IS NOT NULL
      AND broker_settlement_outcome IS NOT NULL
      AND settlement_envelope IS NOT NULL
    ORDER BY resolved_at ASC NULLS LAST
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);
  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r['id']),
      locJobId: String(r['loc_job_id']),
      brokerJobId: requiredText(r, 'broker_job_id'),
      workUnit: requiredText(r, 'selected_work_unit'),
      actualUnits: safeIntegerFromDatabase(r['broker_actual_units'], 'broker_actual_units'),
      outcome: requiredText(r, 'broker_settlement_outcome'),
      settlement: requiredRecord(r, 'settlement_envelope'),
      settleAttempts: requiredNonnegativeInteger(r, 'settle_attempts'),
    };
  });
}

export interface LocSettlementResult {
  actualUnits: number;
  billedValueWei: string;
  outcome: string;
}

export async function markSettled(
  db: Db,
  id: string,
  result: LocSettlementResult | null,
): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      settleState: 'settled',
      settledAt: new Date(),
      lastSettleError: null,
      ...(result
        ? {
            locSettledUnits: String(result.actualUnits),
            locBilledValueWei: result.billedValueWei,
            locSettlementOutcome: result.outcome,
          }
        : {}),
    })
    .where(eq(usageReservations.id, id));
}

/** Record a settlement attempt. Transient failures remain pending without
 * a retry ceiling; permanent evidence/contract failures stop for review. */
export async function recordSettleFailure(
  db: Db,
  id: string,
  errorText: string,
  permanent: boolean,
): Promise<void> {
  await db
    .update(usageReservations)
    .set({
      settleAttempts: sql`${usageReservations.settleAttempts} + 1`,
      settleState: permanent ? 'failed' : 'pending',
      lastSettleError: errorText.slice(0, 500),
    })
    .where(eq(usageReservations.id, id));
}

function safeIntegerFromDatabase(value: unknown, field: string): number {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`invalid ${field} in pending settlement row`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the gateway safe integer range`);
  }
  return parsed;
}

function requiredRecord(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = row[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${field} in pending settlement row`);
  }
  return value as Record<string, unknown>;
}

/** Pending-settle backlog size, surfaced via /health and metrics. */
export async function pendingSettleCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageReservations)
    .where(eq(usageReservations.settleState, 'pending'));
  return row?.n ?? 0;
}

export async function listByApiKey(
  db: Db,
  apiKeyId: string,
  limit = 100,
  offset = 0,
): Promise<UsageReservation[]> {
  return await db
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.apiKeyId, apiKeyId))
    .orderBy(desc(usageReservations.createdAt))
    .limit(limit)
    .offset(offset);
}

export interface UsageSummary {
  apiKeyId: string;
  email: string;
  totalRequests: number;
  committedTotal: number;
  refundedTotal: number;
  lastUsedAt: Date | null;
}

/** Aggregate by-API-key summary, joined to the owning user email. */
export async function summaryByApiKey(
  db: Db,
  limit = 100,
): Promise<UsageSummary[]> {
  const rows = await db
    .select({
      apiKeyId: usageReservations.apiKeyId,
      email: waitlist.email,
      totalRequests: sql<number>`count(*)::int`,
      committedTotal: sql<number>`count(*) FILTER (WHERE ${usageReservations.state} = 'committed')::int`,
      refundedTotal: sql<number>`count(*) FILTER (WHERE ${usageReservations.state} = 'refunded')::int`,
      lastUsedAt: sql<Date | null>`max(${usageReservations.createdAt})`,
    })
    .from(usageReservations)
    .innerJoin(apiKeys, eq(apiKeys.id, usageReservations.apiKeyId))
    .innerJoin(waitlist, eq(waitlist.id, apiKeys.waitlistId))
    .groupBy(usageReservations.apiKeyId, waitlist.email)
    .orderBy(sql`max(${usageReservations.createdAt}) DESC`)
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    lastUsedAt: normalizeTimestamp(row.lastUsedAt),
  }));
}

/** For admin's per-user usage view. */
export async function summaryByWaitlist(
  db: Db,
  waitlistId: string,
): Promise<{
  totalRequests: number;
  committedTotal: number;
  refundedTotal: number;
  lastUsedAt: Date | null;
}> {
  const [row] = await db
    .select({
      totalRequests: sql<number>`count(*)::int`,
      committedTotal: sql<number>`count(*) FILTER (WHERE ${usageReservations.state} = 'committed')::int`,
      refundedTotal: sql<number>`count(*) FILTER (WHERE ${usageReservations.state} = 'refunded')::int`,
      lastUsedAt: sql<Date | null>`max(${usageReservations.createdAt})`,
    })
    .from(usageReservations)
    .innerJoin(apiKeys, eq(apiKeys.id, usageReservations.apiKeyId))
    .where(eq(apiKeys.waitlistId, waitlistId));
  if (!row) {
    return {
      totalRequests: 0,
      committedTotal: 0,
      refundedTotal: 0,
      lastUsedAt: null,
    };
  }
  return {
    ...row,
    lastUsedAt: normalizeTimestamp(row.lastUsedAt),
  };
}

/** Cheap "recent successful requests in last hour" count for /health. */
export async function recentSuccessCount(
  db: Db,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageReservations)
    .where(
      and(
        eq(usageReservations.state, 'committed'),
        gt(usageReservations.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

function normalizeTimestamp(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
