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
