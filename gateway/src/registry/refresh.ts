// Background task that pulls the current capability snapshot from the
// LOC clearinghouse (via the registry catalog reader) and upserts it
// into the `models` table.
//
// `/v1/models` reads from `models`. The proxy path opens LOC jobs on
// demand per request — this refresh task exists so the catalog endpoint
// isn't blocked on an HTTP call to the LOC.
//
// Note: LOC's capability listing carries no display metadata
// (name/description/provider/category), so those columns are only ever
// populated by operator overrides — preserved by the coalesce upsert.

import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db.js';
import { models, type NewModel } from '../schema/index.js';
import type {
  RegistryCatalog,
  RouteCandidate,
} from './catalog.js';

export interface StartRefreshInput {
  registryCatalog: RegistryCatalog;
  db: Db;
  intervalMs: number;
  log: FastifyBaseLogger | Console;
}

/** Cancel function — call to stop the periodic refresh. */
export type CancelRefresh = () => void;

export function startRegistryRefresh(input: StartRefreshInput): CancelRefresh {
  const { registryCatalog, db, intervalMs, log } = input;

  const run = async (): Promise<void> => {
    const candidates = await registryCatalog.inspect();
    const count = await upsertModelsFromSnapshot(db, candidates);
    log.debug({ count }, 'registry refresh upserted models');
  };

  // Kick off immediately, then on interval. Don't await — we don't want
  // to block boot on the first registry call.
  void run().catch((err) => {
    log.error({ err }, 'registry refresh failed (initial)');
  });

  const handle = setInterval(() => {
    void run().catch((err) => {
      log.error({ err }, 'registry refresh failed');
    });
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  handle.unref?.();

  return () => clearInterval(handle);
}

/**
 * Convert RouteCandidate[] → models rows and upsert. Rows present in
 * the DB but missing from this snapshot are marked `active=false` so
 * `/v1/models` reflects current reality.
 */
export async function upsertModelsFromSnapshot(
  db: Db,
  candidates: RouteCandidate[],
): Promise<number> {
  const rows = candidatesToModelRows(candidates);

  await db.transaction(async (tx) => {
    // The table is a snapshot cache. Mark the previous snapshot inactive
    // inside the transaction, then reactivate every row present now. This
    // handles the same offering id appearing under multiple capabilities.
    await tx.update(models).set({ active: false }).where(eq(models.active, true));
    if (rows.length > 0) {
      await tx
        .insert(models)
        .values(rows)
        .onConflictDoUpdate({
          target: [models.capability, models.modelId],
          set: {
            capability: sql`excluded.capability`,
            protocol: sql`excluded.protocol`,
            transports: sql`excluded.transports`,
            ethAddress: sql`excluded.eth_address`,
            pricePerWorkUnitWei: sql`excluded.price_per_work_unit_wei`,
            brokerUrl: sql`excluded.broker_url`,
            unitsPerPrice: sql`excluded.units_per_price`,
            quoteId: sql`excluded.quote_id`,
            quoteVersion: sql`excluded.quote_version`,
            constraintFingerprintHex: sql`excluded.constraint_fingerprint_hex`,
            routeFingerprintHex: sql`excluded.route_fingerprint_hex`,
            extraJson: sql`excluded.extra_json`,
            constraintsJson: sql`excluded.constraints_json`,
            // Display fields: only write if the new row has them (don't
            // clobber operator-set overrides with NULL).
            name: sql`coalesce(excluded.name, ${models.name})`,
            description: sql`coalesce(excluded.description, ${models.description})`,
            provider: sql`coalesce(excluded.provider, ${models.provider})`,
            category: sql`coalesce(excluded.category, ${models.category})`,
            active: sql`true`,
            snapshotAt: sql`excluded.snapshot_at`,
          },
        });
    }
  });

  return rows.length;
}

/**
 * Pure transform: RouteCandidate[] → models rows. De-duplicates by
 * capability+modelId (last wins), drops candidates with no offering id,
 * extracts display fields from `extra.openai` (preferred) or `extra`
 * itself. Exported for unit tests.
 */
export function candidatesToModelRows(candidates: RouteCandidate[]): NewModel[] {
  const rowsByIdentity = new Map<string, NewModel>();
  for (const c of candidates) {
    const modelId = c.offering.trim();
    if (!modelId) continue;
    const extraObj =
      c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)
        ? (c.extra as Record<string, unknown>)
        : null;
    const openai =
      extraObj && typeof extraObj['openai'] === 'object' && extraObj['openai'] !== null
        ? (extraObj['openai'] as Record<string, unknown>)
        : null;
    rowsByIdentity.set(`${c.capability}\u0000${modelId}`, {
      modelId,
      capability: c.capability,
      protocol: c.protocol,
      transports: c.transports,
      name: pickString(openai, 'name') ?? pickString(extraObj, 'name'),
      description:
        pickString(openai, 'description') ?? pickString(extraObj, 'description'),
      provider: pickString(extraObj, 'provider'),
      category: pickString(extraObj, 'category'),
      ethAddress: c.ethAddress || null,
      pricePerWorkUnitWei: c.pricePerWorkUnitWei || null,
      brokerUrl: c.brokerUrl || null,
      unitsPerPrice: c.unitsPerPrice,
      quoteId: c.quoteId || null,
      quoteVersion: String(c.quoteVersion ?? 0),
      constraintFingerprintHex: bytesToHex(c.constraintFingerprint),
      routeFingerprintHex: bytesToHex(c.routeFingerprint),
      extraJson: (c.extra as unknown as NewModel['extraJson']) ?? null,
      constraintsJson: (c.constraints as unknown as NewModel['constraintsJson']) ?? null,
      active: true,
      snapshotAt: new Date(),
    });
  }
  return [...rowsByIdentity.values()];
}

function pickString(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function bytesToHex(bytes: Uint8Array): string | null {
  return bytes.length > 0 ? Buffer.from(bytes).toString('hex') : null;
}
