# Boot sequence

What happens between `node ./dist/index.js` and the gateway accepting
connections. Failure modes per step. Graceful shutdown contract.

## Steps

```text
1.  loadConfig()                                                  [throws on bad env]
      └─ requires LOC_API_KEY (+ LOC_BASE_URL, default loc.cloudspe.com)

2.  warn-if-unset peppers (API_KEY_HASH_PEPPER, IP_HASH_PEPPER)    [non-fatal]

3.  createPool(databaseUrl)                                       [lazy — no connection yet]
    createDb(pool)                                                [pure wrapper]

4.  runMigrations(db)                                             [throws on SQL failure]
      ├─ CREATE TABLE _schema_migrations IF NOT EXISTS
      ├─ SELECT applied filenames
      └─ For each unapplied .sql file (numeric sort):
         BEGIN; <SQL>; INSERT _schema_migrations; COMMIT

5.  createLocClient(config)                                       [pure — does not network]
      └─ best-effort loc.health() probe:
         WARN-AND-CONTINUE on failure (a LOC outage must not stop boot;
         /health reports the LOC as down until it recovers)

6.  createRegistryCatalog(loc)                                    [pure — LOC-backed]

7.  createEmailClient({ apiKey, baseUrl, fromEmail })             [pure — does not network]
      └─ if !apiKey: enabled=false; log warns; sends become log lines

8.  createRateLimiter(config); rateLimiter.start()               [pure + idle-evict interval]

9.  buildServer({ config, db, pool, email, loc, registryCatalog, rateLimiter })
      ├─ Fastify({ logger, trustProxy })
      ├─ register cors, cookie
      ├─ attachHttpMetrics (onRequest/onResponse hooks)
      ├─ /health, /healthz, /v1/models, /metrics
      ├─ /api/* (public)
      ├─ /portal/* (cookie sessions)
      ├─ /admin/*  (X-Admin-Token gate)
      └─ /v1/* (Bearer + rate-limit preHandlers)

10. startRegistryRefresh({…})                                     [non-blocking]
      └─ kick off first catalog refresh, schedule setInterval(intervalMs)

11. startSettler({ db, loc, intervalMs, maxAttempts })            [non-blocking]
      └─ schedule the durable settle-intent drain loop

12. app.listen({ port, host })                                    [throws if port busy]
```

The whole sequence takes < 1s in dev. The slow step is the migration
SQL; the LOC health probe is best-effort and bounded.

## Failure modes — per step

| Step | If it fails | Recovery |
|---|---|---|
| 1 | Process exits with the validation message | Fix env (e.g. missing `LOC_API_KEY`), restart |
| 4 | Process exits — migration is half-applied (rolled back by the tx) | Fix the SQL, restart. Migration runner is idempotent. |
| 5 | LOC probe failure is **non-fatal** — boot logs a warning and continues | Operator fixes LOC reachability / `LOC_API_KEY`; `/health` and `/v1/*` recover when the LOC does |
| 9 | Throws if a route registration is malformed (a code bug) | Fix code |
| 10 | Logs and continues — refresh task survives one failure and tries again | Operator addresses LOC catalog issue; refresh recovers itself |
| 11 | Logs and continues — settler retries pending intents each tick | Operator addresses LOC reachability; refunds drain once it's back |
| 12 | Process exits with EADDRINUSE | Free the port |

## Graceful shutdown

`SIGINT` and `SIGTERM` both invoke `shutdown(signal)`:

```text
1. log "shutting down"
2. cancelRefresh()           — stop the catalog refresh interval
3. cancelSettler()           — stop the settle-intent drain loop
4. rateLimiter.stop()        — clear the evict interval
5. registryCatalog.close?.() — release any catalog resources
6. app.close()               — stop accepting + drain in-flight
7. pool.end()                — close all Postgres connections
8. process.exit(0)
```

In-flight `/v1/*` streams get terminated by step 6's drain. The client
sees a half-finished SSE response. We accept this — see
[`streaming-usage.md`](./streaming-usage.md): mid-stream errors are the
streaming contract's known limitation.

A shutdown mid-request can leave a `settle_state='pending'` row whose
settle never fired this process; the next process's settler picks it up.
Pending intents are durable in Postgres, not in memory.

## Why this ordering

- **Config first.** Anything else risks running with bad env.
- **DB before everything else.** The migrations need to land before any
  route handler can read its schema. A late migration means a brief 500
  window for early traffic — not acceptable.
- **LOC client is warn-and-continue.** The LOC is an external HTTP
  dependency; an outage at boot must not crash the gateway. The SaaS
  surfaces (`/portal/*`, `/admin/*`, public) still work off Postgres;
  `/v1/*` errors and `/health` reports `loc: down` until it recovers.
- **Background tasks before listen would be fine either way.** They're
  scheduled before listen for code simplicity (no awaitable promise to
  track).

## Where it lives

| Concern | File |
|---|---|
| Boot orchestration | `gateway/src/index.ts` |
| Config validation | `gateway/src/config.ts` |
| Migration runner | `gateway/src/db.ts` |
| Fastify factory | `gateway/src/server.ts` |
| LOC client (+ best-effort health probe) | `gateway/src/loc/client.ts` |
| LOC-backed catalog | `gateway/src/registry/catalog.ts` |
| Refresh task lifecycle | `gateway/src/registry/refresh.ts` |
| Settler task lifecycle | `gateway/src/loc/settler.ts` |
| Rate limiter lifecycle | `gateway/src/proxy/rateLimit.ts` |
