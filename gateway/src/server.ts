// Fastify factory. Build an app instance, register plugins + routes,
// return without listening. `index.ts` owns the listen() call.

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { Config } from './config.js';
import type { Db, Pool } from './db.js';
import type { EmailClient } from './email/index.js';
import type { RateLimiter } from './proxy/rateLimit.js';
import type { RouteSelector } from './proxy/service/routeSelector.js';
import type { RegistryCatalog } from './registry/catalog.js';

import { attachHttpMetrics, registerMetricsRoute } from './metrics.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerModelsRoute } from './routes/models.js';
import { registerWaitlistRoutes } from './routes/public/waitlist.js';
import { registerVerifyRoutes } from './routes/public/verify.js';
import { registerPortalAuthRoutes } from './routes/portal/auth.js';
import { registerAccountRoutes } from './routes/portal/account.js';
import { registerApiKeyRoutes } from './routes/portal/apiKeys.js';
import { registerPlaygroundRoutes } from './routes/portal/playground.js';
import { registerUsageRoutes } from './routes/portal/usage.js';
import { registerAdminRoutes } from './routes/admin/index.js';
import { registerProxyRoutes } from './proxy/index.js';

export interface ServerDeps {
  config: Config;
  db: Db;
  pool: Pool;
  email: EmailClient;
  routeSelector: RouteSelector;
  registryCatalog: RegistryCatalog;
  rateLimiter: RateLimiter;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: ServerDeps;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '../../web');
const SITE_ROOT = resolve(WEB_ROOT, 'site');
const PORTAL_ROOT = resolve(WEB_ROOT, 'portal');
const ADMIN_ROOT = resolve(WEB_ROOT, 'admin');

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    logger: { level: config.logLevel },
    disableRequestLogging: false,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  // zod ↔ Fastify schema bridge.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('deps', deps);

  await app.register(cors, {
    origin:
      config.allowedOrigins === '*'
        ? true
        : config.allowedOrigins.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: SITE_ROOT,
    serve: false,
  });

  // ── OpenAPI ────────────────────────────────────────────────────
  // Documents `/api/*`, `/portal/*`, `/admin/*`. Excludes `/v1/*`
  // (covered by OpenAI's published spec) and infra endpoints.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'OpenAI Service — operator + portal API',
        description:
          'Non-OpenAI surfaces hosted by the gateway. `/v1/*` follows OpenAI\'s spec.',
        version: '0.1.0',
      },
      servers: [{ url: config.baseUrl }],
      tags: [
        { name: 'public', description: 'Unauthenticated signup + verification.' },
        { name: 'portal', description: 'Authenticated user surface (cookie session).' },
        { name: 'admin', description: 'Operator surface (X-Admin-Token header).' },
      ],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'openai_service_session',
            description: 'Session cookie issued by POST /portal/login.',
          },
          adminToken: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Admin-Token',
            description: 'Operator token (matches gateway ADMIN_TOKEN env).',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    hideUntagged: true,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Canonical OpenAPI document endpoint. `/docs/json` exists too
  // (swagger-ui default) but `/openapi.json` is the standard path
  // most tooling looks for first.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // ── Instrumentation (must register hooks before routes) ──────────
  attachHttpMetrics(app);

  // ── Always-on ────────────────────────────────────────────────────
  await registerHealthRoutes(app);
  await registerModelsRoute(app, deps);
  await registerMetricsRoute(app, deps);
  registerSpaRoutes(app);

  // ── Public (no auth) ─────────────────────────────────────────────
  await registerWaitlistRoutes(app, deps);
  await registerVerifyRoutes(app, deps);

  // ── Portal (cookie session) ──────────────────────────────────────
  await registerPortalAuthRoutes(app, deps);
  await registerAccountRoutes(app, deps);
  await registerApiKeyRoutes(app, deps);
  await registerPlaygroundRoutes(app, deps);
  await registerUsageRoutes(app, deps);

  // ── Admin (X-Admin-Token) ────────────────────────────────────────
  await registerAdminRoutes(app, deps);

  // ── Proxy /v1/* (Bearer API key) ─────────────────────────────────
  await registerProxyRoutes(app, deps);

  return app;
}

function registerSpaRoutes(app: FastifyInstance): void {
  app.get('/portal', async (_req, reply) => reply.redirect('/portal/'));
  app.get('/admin', async (_req, reply) => reply.redirect('/admin/'));

  app.get('/portal/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').sendFile('index.html', PORTAL_ROOT, {
      maxAge: 0,
      immutable: false,
    }),
  );
  app.get('/admin/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').sendFile('index.html', ADMIN_ROOT, {
      maxAge: 0,
      immutable: false,
    }),
  );

  app.get('/portal/static/*', async (req, reply) => {
    const assetPath = trimPrefix(req.raw.url ?? req.url, '/portal/static/');
    if (!assetPath || !(await fileExists(PORTAL_ROOT, assetPath))) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return reply.sendFile(assetPath, PORTAL_ROOT);
  });

  app.get('/admin/static/*', async (req, reply) => {
    const assetPath = trimPrefix(req.raw.url ?? req.url, '/admin/static/');
    if (!assetPath || !(await fileExists(ADMIN_ROOT, assetPath))) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return reply.sendFile(assetPath, ADMIN_ROOT);
  });

  app.get('/*', async (req, reply) => {
    const url = new URL(req.raw.url ?? req.url, 'http://localhost');
    const pathname = url.pathname;
    if (isReservedPath(pathname)) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }

    const sitePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (await fileExists(SITE_ROOT, sitePath)) {
      return reply.sendFile(sitePath, SITE_ROOT);
    }

    return reply.type('text/html; charset=utf-8').sendFile('index.html', SITE_ROOT, {
      maxAge: 0,
      immutable: false,
    });
  });
}

function isReservedPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/portal/') ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/docs') ||
    pathname === '/openapi.json' ||
    pathname === '/metrics' ||
    pathname === '/healthz'
  );
}

function trimPrefix(urlPath: string, prefix: string): string {
  const pathname = new URL(urlPath, 'http://localhost').pathname;
  if (!pathname.startsWith(prefix)) return '';
  return pathname.slice(prefix.length);
}

async function fileExists(root: string, relativePath: string): Promise<boolean> {
  const absolutePath = resolve(root, relativePath);
  if (!absolutePath.startsWith(root)) return false;
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
