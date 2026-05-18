// GET /api/verify?token=<plaintext> — verify email by clicking link.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { hashVerificationToken } from '../../crypto.js';
import * as waitlistRepo from '../../repo/waitlist.js';
import { ErrorBody } from '../../schema/api.js';

const QuerySchema = z.object({
  token: z.string().min(8).max(256),
});

const VerifyResponse = z
  .object({
    ok: z.literal(true),
    message: z.string(),
  })
  .meta({ id: 'VerifyResponse' });

export async function registerVerifyRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/verify',
    {
      schema: {
        tags: ['public'],
        summary: 'Verify a signup email',
        description:
          'Consumes a single-use verification token (from the signup email). ' +
          'On success, marks the waitlist row as email-verified.',
        querystring: QuerySchema,
        response: {
          200: VerifyResponse,
          400: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const tokenHash = hashVerificationToken(
        req.query.token,
        deps.config.ipHashPepper,
      );
      const row = await waitlistRepo.findVerifiableByToken(
        deps.db,
        tokenHash,
        new Date(),
      );
      if (!row) {
        return reply.code(400).send({
          error: {
            message: 'verification link is invalid or expired',
            type: 'invalid_request_error',
            code: 'invalid_token',
          },
        });
      }
      await waitlistRepo.markVerified(deps.db, row.id);
      req.log.info({ email: row.email }, 'email verified');
      return reply.send({
        ok: true as const,
        message:
          'Email verified. Your signup is in the admin review queue; you will receive your API key by email once approved.',
      });
    },
  );
}
