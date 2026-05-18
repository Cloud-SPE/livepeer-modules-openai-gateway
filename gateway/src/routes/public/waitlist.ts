// POST /api/waitlist — public signup endpoint.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { generateVerificationToken, hashIp } from '../../crypto.js';
import * as waitlistRepo from '../../repo/waitlist.js';
import { waitlistSignupsTotal } from '../../metrics.js';
import { ErrorBody, OkBody } from '../../schema/api.js';

const SignupSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(254),
  })
  .meta({ id: 'WaitlistSignup' });

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_MAX = 5;

export async function registerWaitlistRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/waitlist',
    {
      schema: {
        tags: ['public'],
        summary: 'Join the waitlist',
        description:
          'Create a pending waitlist row and email a verification link. ' +
          'Idempotent on existing email (same shape returned). IP-hash ' +
          'rate-limited (5/hour).',
        body: SignupSchema,
        response: {
          200: OkBody,
          400: ErrorBody,
          429: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const { name, email } = req.body;
      const lowerEmail = email.toLowerCase();

      const ip = req.ip;
      const ipHash = ip ? hashIp(ip, deps.config.ipHashPepper) : null;
      if (ipHash) {
        const recent = await waitlistRepo.countRecentByIpHash(
          deps.db,
          ipHash,
          RATE_LIMIT_WINDOW_MS,
        );
        if (recent >= RATE_LIMIT_MAX) {
          return reply.code(429).send({
            error: {
              message:
                'too many signups from this IP recently — try again later',
              type: 'rate_limit_exceeded',
              code: 'ip_rate_limit',
            },
          });
        }
      }

      const existing = await waitlistRepo.findByEmail(deps.db, lowerEmail);
      if (existing) {
        req.log.info({ email: lowerEmail }, 'waitlist signup: email exists, no-op');
        return reply.send({ ok: true as const });
      }

      const token = generateVerificationToken(deps.config.ipHashPepper);
      await waitlistRepo.createWaitlist(deps.db, {
        name,
        email: lowerEmail,
        ipHash,
        verificationTokenHash: token.hash,
        verificationTokenExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
      });

      try {
        await deps.email.sendVerification({
          email: lowerEmail,
          name,
          token: token.plaintext,
          baseUrl: deps.config.publicSiteUrl,
        });
      } catch (err) {
        req.log.error({ err, email: lowerEmail }, 'verification email send failed');
      }

      waitlistSignupsTotal.inc();
      return reply.send({ ok: true as const });
    },
  );
}
