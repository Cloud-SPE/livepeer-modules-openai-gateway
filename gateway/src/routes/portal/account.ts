// GET /portal/account — current user's basic profile.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { ErrorBody } from '../../schema/api.js';
import { requirePortalSession } from './auth.js';

const AccountResponse = z
  .object({
    email: z.string(),
    name: z.string(),
    waitlistId: z.string().uuid(),
  })
  .meta({ id: 'AccountResponse' });

export async function registerAccountRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/portal/account',
    {
      schema: {
        tags: ['portal'],
        summary: 'Current account',
        security: [{ cookieAuth: [] }],
        response: { 200: AccountResponse, 401: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async (req) => {
      const s = req.portalSession!;
      return { email: s.email, name: s.name, waitlistId: s.waitlistId };
    },
  );
}
