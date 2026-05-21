// Admin waitlist queue + approve/reject.
//
// Approval flow:
//   1. Admin sees pending+verified rows in /admin/waitlist?status=pending
//   2. Admin POSTs /admin/waitlist/:id/approve
//   3. Generate API key → insert api_keys row → set waitlist.status='approved'.
//   4. Email plaintext key to user.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { generateApiKey, generateVerificationToken } from '../../crypto.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import * as waitlistRepo from '../../repo/waitlist.js';
import { waitlist } from '../../schema/index.js';
import {
  ErrorBody,
  PaginationQuery,
  UuidParam,
  WaitlistRow,
} from '../../schema/api.js';

const ListQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

const ListResponse = z
  .object({ data: z.array(WaitlistRow) })
  .meta({ id: 'AdminWaitlistList' });

const ApproveResponse = z
  .object({
    ok: z.literal(true),
    apiKey: z.object({
      plaintextKey: z.string(),
      keyPrefix: z.string(),
    }),
    emailDelivery: z.object({
      status: z.enum(['sent', 'logged', 'failed']),
      message: z.string(),
    }),
  })
  .meta({ id: 'AdminWaitlistApprove' });

const OkBody = z.object({ ok: z.literal(true) }).meta({
  id: 'AdminOkBody',
  description: 'Generic acknowledgement.',
});

const ADMIN_SECURITY = [{ adminToken: [] as string[] }];

export async function registerAdminWaitlistRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/admin/waitlist',
    {
      schema: {
        tags: ['admin'],
        summary: 'List waitlist rows',
        description: 'Filterable by status. Default: all statuses.',
        security: ADMIN_SECURITY,
        querystring: ListQuery,
        response: { 200: ListResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async (req) => {
      const rows = await waitlistRepo.list(deps.db, {
        status: req.query.status,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          status: r.status as 'pending' | 'approved' | 'rejected',
          emailVerifiedAt: r.emailVerifiedAt,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          approvedBy: r.approvedBy,
        })),
      };
    },
  );

  f.post(
    '/admin/waitlist/:id/approve',
    {
      schema: {
        tags: ['admin'],
        summary: 'Approve a waitlist row',
        description:
          'Mints an API key, emails the plaintext to the user, and sets ' +
          'status=approved. Email verification is not required.',
        security: ADMIN_SECURITY,
        params: UuidParam,
        response: {
          200: ApproveResponse,
          401: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const row = await waitlistRepo.findById(deps.db, req.params.id);
      if (!row) {
        return reply.code(404).send({
          error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' },
        });
      }
      if (row.status === 'approved') {
        return reply.code(409).send({
          error: {
            message: 'already approved',
            type: 'invalid_request_error',
            code: 'already_approved',
          },
        });
      }
      const { plaintext, prefix, hash } = generateApiKey(deps.config.apiKeyHashPepper);
      await deps.db.transaction(async () => {
        await apiKeysRepo.create(deps.db, {
          waitlistId: row.id,
          label: 'Initial key',
          keyPrefix: prefix,
          keyHash: hash,
        });
        await waitlistRepo.approve(deps.db, row.id, 'admin-token');
      });

      let emailDelivery:
        | { status: 'sent' | 'logged' | 'failed'; message: string } = deps.email.enabled
        ? {
            status: 'sent',
            message: 'API key email sent to the user.',
          }
        : {
            status: 'logged',
            message:
              'Email delivery is disabled because RESEND_API_KEY is unset. Hand the key to the user now.',
          };
      try {
        await deps.email.sendApiKey({
          email: row.email,
          name: row.name,
          plaintextKey: plaintext,
          portalUrl: deps.config.publicPortalUrl,
        });
      } catch (err) {
        req.log.error(
          { err, email: row.email },
          'api-key delivery email failed — admin must hand-deliver',
        );
        emailDelivery = {
          status: 'failed',
          message: 'API key email failed. Hand the key to the user now.',
        };
      }
      return {
        ok: true as const,
        apiKey: {
          plaintextKey: plaintext,
          keyPrefix: prefix,
        },
        emailDelivery,
      };
    },
  );

  f.post(
    '/admin/waitlist/:id/reject',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reject a waitlist row',
        security: ADMIN_SECURITY,
        params: UuidParam,
        response: { 200: OkBody, 401: ErrorBody, 404: ErrorBody, 503: ErrorBody },
      },
    },
    async (req, reply) => {
      const row = await waitlistRepo.findById(deps.db, req.params.id);
      if (!row) {
        return reply.code(404).send({
          error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' },
        });
      }
      await waitlistRepo.reject(deps.db, row.id, 'admin-token');
      return { ok: true as const };
    },
  );

  f.post(
    '/admin/waitlist/:id/resend-verification',
    {
      schema: {
        tags: ['admin'],
        summary: 'Issue a fresh verification token + email',
        description: 'Invalidates the previous token. 409 if already verified.',
        security: ADMIN_SECURITY,
        params: UuidParam,
        response: {
          200: OkBody,
          401: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
          502: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const row = await waitlistRepo.findById(deps.db, req.params.id);
      if (!row) {
        return reply.code(404).send({
          error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' },
        });
      }
      if (row.emailVerifiedAt) {
        return reply.code(409).send({
          error: {
            message: 'already verified',
            type: 'invalid_request_error',
            code: 'already_verified',
          },
        });
      }
      const token = generateVerificationToken(deps.config.ipHashPepper);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await deps.db
        .update(waitlist)
        .set({
          verificationTokenHash: token.hash,
          verificationTokenExpiresAt: expiresAt,
        })
        .where(eq(waitlist.id, row.id));
      try {
        await deps.email.sendVerification({
          email: row.email,
          name: row.name,
          token: token.plaintext,
          baseUrl: deps.config.publicSiteUrl,
        });
      } catch (err) {
        req.log.error({ err, email: row.email }, 'resend verification failed');
        return reply.code(502).send({
          error: {
            message: 'email send failed',
            type: 'api_error',
            code: 'email_send_failed',
          },
        });
      }
      return { ok: true as const };
    },
  );
}
