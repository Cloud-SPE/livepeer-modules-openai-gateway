// Register all /admin/* routes behind the admin-token gate.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../../server.js';
import { requireAdminToken } from './auth.js';
import { registerAdminWaitlistRoutes } from './waitlist.js';
import { registerAdminUserRoutes } from './users.js';
import { registerAdminUsageRoutes } from './usage.js';
import { registerAdminRegistryRoutes } from './registry.js';

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  // Single gate on every /admin/* route.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    await requireAdminToken(deps)(req, reply);
  });

  await registerAdminWaitlistRoutes(app, deps);
  await registerAdminUserRoutes(app, deps);
  await registerAdminUsageRoutes(app, deps);
  await registerAdminRegistryRoutes(app, deps);
}
