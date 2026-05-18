import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '../db.js';
import { models, type Model } from '../schema/index.js';

export async function listActive(db: Db): Promise<Model[]> {
  return await db
    .select()
    .from(models)
    .where(eq(models.active, true))
    .orderBy(asc(models.capability), asc(models.modelId));
}

export async function listAll(db: Db): Promise<Model[]> {
  return await db
    .select()
    .from(models)
    .orderBy(asc(models.capability), asc(models.modelId));
}

export async function findActiveByCapability(
  db: Db,
  capability: string,
): Promise<Model[]> {
  return await db
    .select()
    .from(models)
    .where(and(eq(models.capability, capability), eq(models.active, true)))
    .orderBy(asc(models.modelId));
}
