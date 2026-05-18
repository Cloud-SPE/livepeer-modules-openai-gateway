import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db.js';
import { apiKeys, type ApiKey } from '../schema/index.js';

export interface CreateApiKeyInput {
  waitlistId: string;
  label: string | null;
  keyPrefix: string;
  keyHash: string;
}

export async function create(db: Db, input: CreateApiKeyInput): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values(input).returning();
  return row!;
}

export async function findByHash(db: Db, keyHash: string): Promise<ApiKey | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return row ?? null;
}

export async function findById(db: Db, id: string): Promise<ApiKey | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return row ?? null;
}

export async function listByWaitlist(db: Db, waitlistId: string): Promise<ApiKey[]> {
  return await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.waitlistId, waitlistId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revoke(db: Db, id: string, waitlistId: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.waitlistId, waitlistId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return result.length > 0;
}

/** Cheap touch on the /v1/* hot path. Doesn't block the request. */
export async function markUsed(db: Db, id: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiKeys.id, id));
}
