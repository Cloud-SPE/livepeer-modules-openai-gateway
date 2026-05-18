// Shared API-surface schemas used across route registrations.
//
// These are zod schemas — they validate runtime input AND get
// converted to OpenAPI 3.1 by fastify-type-provider-zod.
//
// Per-route request schemas (SignupSchema, LoginSchema, etc.) stay
// co-located with the route file. This module holds the cross-cutting
// shapes: error bodies, pagination, common IDs, common responses.

import { z } from 'zod';

// ── error body (OpenAI shape) ────────────────────────────────────

export const ErrorBody = z
  .object({
    error: z
      .object({
        message: z.string(),
        type: z.string(),
        code: z.string().optional(),
      })
      .meta({ description: 'Error envelope (OpenAI shape).' }),
  })
  .meta({ id: 'ErrorBody' });

export const OkBody = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'OkBody', description: 'Generic acknowledgement.' });

// ── pagination ──────────────────────────────────────────────────

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// ── id params ───────────────────────────────────────────────────

export const UuidParam = z.object({
  id: z.string().uuid().meta({ description: 'UUID' }),
});

// ── timestamps ──────────────────────────────────────────────────

/** ISO 8601 timestamp string. zod transforms `Date` to ISO via .toISOString() at the serializer. */
export const Timestamp = z.union([z.string().datetime(), z.date()]);

// ── waitlist (used by public + admin) ───────────────────────────

export const WaitlistRow = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    status: z.enum(['pending', 'approved', 'rejected']),
    emailVerifiedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    approvedAt: Timestamp.nullable(),
    approvedBy: z.string().nullable(),
  })
  .meta({ id: 'WaitlistRow' });

// ── api keys ────────────────────────────────────────────────────

export const ApiKeyPublic = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    keyPrefix: z.string().meta({ description: 'sk-<8 chars> — safe to display.' }),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .meta({ id: 'ApiKeyPublic' });

export const ApiKeyWithPlaintext = ApiKeyPublic.extend({
  plaintextKey: z.string().meta({
    description: 'The full key. Shown exactly once at creation; never recoverable.',
  }),
}).meta({ id: 'ApiKeyWithPlaintext' });

// ── usage reservation rows ──────────────────────────────────────

export const UsageReservationRow = z
  .object({
    id: z.string().uuid(),
    workId: z.string().uuid(),
    apiKeyId: z.string().uuid(),
    capability: z.string(),
    model: z.string(),
    brokerUrl: z.string().nullable(),
    ethAddress: z.string().nullable(),
    selectedCapability: z.string().nullable(),
    selectedOffering: z.string().nullable(),
    selectedWorkUnit: z.string().nullable(),
    unitsPerPrice: z.number().nullable(),
    pricePerWorkUnitWei: z.string().nullable(),
    quoteId: z.string().nullable(),
    quoteVersion: z.string().nullable(),
    constraintFingerprintHex: z.string().nullable(),
    routeFingerprintHex: z.string().nullable(),
    estimatedWorkUnits: z.number().nullable(),
    state: z.enum(['open', 'committed', 'refunded']),
    committedWorkUnits: z.number().nullable(),
    latencyMs: z.number().nullable(),
    statusCode: z.number().nullable(),
    createdAt: Timestamp,
    resolvedAt: Timestamp.nullable(),
  })
  .meta({ id: 'UsageReservationRow' });

// ── route-selector candidates (for admin debug) ─────────────────

export const RouteCandidatePublic = z
  .object({
    brokerUrl: z.string(),
    capability: z.string(),
    offering: z.string(),
    model: z.string().nullable(),
    interactionMode: z.string().nullable(),
    ethAddress: z.string(),
    pricePerWorkUnitWei: z.string(),
    workUnit: z.string(),
    unitsPerPrice: z.number(),
    quoteId: z.string(),
    quoteVersion: z.number(),
    constraintFingerprintHex: z.string().nullable(),
    routeFingerprintHex: z.string().nullable(),
  })
  .meta({ id: 'RouteCandidatePublic' });
