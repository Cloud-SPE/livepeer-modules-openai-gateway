import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../db.js';
import { waitlist, type Waitlist } from '../schema/index.js';

export interface CreateWaitlistInput {
  name: string;
  email: string;
  ipHash: string | null;
  verificationTokenHash: string;
  verificationTokenExpiresAt: Date;
}

export async function createWaitlist(
  db: Db,
  input: CreateWaitlistInput,
): Promise<Waitlist> {
  const [row] = await db
    .insert(waitlist)
    .values({
      name: input.name,
      email: input.email,
      ipHash: input.ipHash,
      verificationTokenHash: input.verificationTokenHash,
      verificationTokenExpiresAt: input.verificationTokenExpiresAt,
    })
    .returning();
  return row!;
}

export async function findByEmail(db: Db, email: string): Promise<Waitlist | null> {
  const [row] = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.email, email))
    .limit(1);
  return row ?? null;
}

export async function findById(db: Db, id: string): Promise<Waitlist | null> {
  const [row] = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.id, id))
    .limit(1);
  return row ?? null;
}

export async function findByVerificationToken(
  db: Db,
  tokenHash: string,
): Promise<Waitlist | null> {
  const [row] = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.verificationTokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function markVerified(db: Db, id: string): Promise<void> {
  await db
    .update(waitlist)
    .set({
      emailVerifiedAt: new Date(),
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
    })
    .where(eq(waitlist.id, id));
}

export async function approve(
  db: Db,
  id: string,
  approvedBy: string,
): Promise<void> {
  await db
    .update(waitlist)
    .set({
      status: 'approved',
      approvedAt: new Date(),
      approvedBy,
    })
    .where(eq(waitlist.id, id));
}

export async function reject(
  db: Db,
  id: string,
  approvedBy: string,
): Promise<void> {
  await db
    .update(waitlist)
    .set({
      status: 'rejected',
      approvedAt: new Date(),
      approvedBy,
    })
    .where(eq(waitlist.id, id));
}

export interface ListInput {
  status?: 'pending' | 'approved' | 'rejected';
  limit?: number;
  offset?: number;
}

export async function list(db: Db, input: ListInput = {}): Promise<Waitlist[]> {
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const filter = input.status ? eq(waitlist.status, input.status) : undefined;
  return await db
    .select()
    .from(waitlist)
    .where(filter)
    .orderBy(desc(waitlist.createdAt))
    .limit(limit)
    .offset(offset);
}

/** Count waitlist rows created from the same IP hash in the last `windowMs` ms. */
export async function countRecentByIpHash(
  db: Db,
  ipHash: string,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlist)
    .where(and(eq(waitlist.ipHash, ipHash), gt(waitlist.createdAt, since)));
  return row?.n ?? 0;
}

/** For verification: check token is valid AND not expired. */
export async function findVerifiableByToken(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<Waitlist | null> {
  const [row] = await db
    .select()
    .from(waitlist)
    .where(
      and(
        eq(waitlist.verificationTokenHash, tokenHash),
        isNotNull(waitlist.verificationTokenExpiresAt),
        gt(waitlist.verificationTokenExpiresAt, now),
        isNull(waitlist.emailVerifiedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** GC helper — drop expired verification tokens. Idempotent. */
export async function clearExpiredVerificationTokens(db: Db): Promise<void> {
  await db
    .update(waitlist)
    .set({ verificationTokenHash: null, verificationTokenExpiresAt: null })
    .where(
      and(
        isNotNull(waitlist.verificationTokenExpiresAt),
        lt(waitlist.verificationTokenExpiresAt, new Date()),
      ),
    );
}
