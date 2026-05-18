import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Db } from '../db.js';
import { userSessions, type UserSession } from '../schema/index.js';

export interface CreateSessionInput {
  apiKeyId: string;
  sessionHash: string;
  expiresAt: Date;
}

export async function create(
  db: Db,
  input: CreateSessionInput,
): Promise<UserSession> {
  const [row] = await db.insert(userSessions).values(input).returning();
  return row!;
}

/** Find an active (not revoked, not expired) session by its hashed token. */
export async function findActive(
  db: Db,
  sessionHash: string,
): Promise<UserSession | null> {
  const [row] = await db
    .select()
    .from(userSessions)
    .where(
      and(
        eq(userSessions.sessionHash, sessionHash),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function revoke(db: Db, id: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(eq(userSessions.id, id));
}

/** Revoke every session tied to an API key (called when the key itself is revoked). */
export async function revokeAllForApiKey(db: Db, apiKeyId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(userSessions.apiKeyId, apiKeyId), isNull(userSessions.revokedAt)),
    );
}
