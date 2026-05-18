# Boot sequence

What happens between `node ./dist/index.js` and the gateway accepting
connections. Failure modes per step. Graceful shutdown contract.

## Steps

```text
1.  loadConfig()                                                  [throws on bad env]
      └─ requires LIVEPEER_RESOLVER_SOCKET (on-chain resolver path)

2.  warn-if-unset peppers (API_KEY_HASH_PEPPER, IP_HASH_PEPPER)    [non-fatal]

3.  createPool(databaseUrl)                                       [lazy — no connection yet]
4.  createDb(pool)                                                [pure wrapper]

5.  runMigrations(db)                                             [throws on SQL failure]
      ├─ CREATE TABLE _schema_migrations IF NOT EXISTS
      ├─ SELECT applied filenames
      └─ For each unapplied .sql file (numeric sort):
         BEGIN; <SQL>; INSERT _schema_migrations; COMMIT

6.  require payer-daemon socket on disk                           [fatal if missing]
      payment.init({ socketPath, protoRoot })
        ├─ loadSync proto files
        ├─ open unix:<socket> gRPC client
        └─ Health probe — must succeed

7.  createRouteSelector(config)                                   [pure — does not dial]
      └─ dial UDS, build resolver-backed selector

8.  createEmailClient({ apiKey, fromEmail })                      [pure — does not network]
      └─ if !apiKey: enabled=false; log warns; sends become log lines

9.  createRateLimiter(config)                                     [pure]
    rateLimiter.start()                                           [registers idle-evict interval]

10. buildServer({ config, db, pool, email, routeSelector, rateLimiter })
      ├─ Fastify({ logger, trustProxy })
      ├─ register cors, cookie
      ├─ attachHttpMetrics (onRequest/onResponse hooks)
      ├─ /health, /healthz, /v1/models, /metrics
      ├─ /api/* (public)
      ├─ /portal/* (cookie sessions)
      ├─ /admin/*  (X-Admin-Token gate)
      └─ /v1/* (Bearer + rate-limit preHandlers)

11. startRegistryRefresh({…})                                     [non-blocking]
      └─ kick off first refresh, schedule setInterval(intervalMs).unref()

12. app.listen({ port, host })                                    [throws if port busy]
```

The whole sequence takes < 1s in dev (the slow steps are the migration
SQL and the optional payer Health probe, both ~50ms each).

## Failure modes — per step

| Step | If it fails | Recovery |
|---|---|---|
| 1 | Process exits with the validation message | Fix env, restart |
| 5 | Process exits — migration is half-applied (rolled back by the tx) | Fix the SQL, restart. Migration runner is idempotent. |
| 6 | Process exits | Operator fixes payer-daemon wiring, restarts |
| 7 | Throws if proto load fails (bad proto root) | Fix `LIVEPEER_RESOLVER_PROTO_ROOT` |
| 9 | (Pure — can't fail) | n/a |
| 10 | Throws if a route registration is malformed (a code bug) | Fix code |
| 11 | Logs and continues — refresh task survives one failure and tries again | Operator addresses registry-daemon issue; refresh recovers itself |
| 12 | Process exits with EADDRINUSE | Free the port |

## Graceful shutdown

`SIGINT` and `SIGTERM` both invoke `shutdown(signal)`:

```text
1. log "shutting down"
2. cancelRefresh()       — stop the registry refresh interval
3. rateLimiter.stop()    — clear the evict interval
4. payment.shutdown()    — close gRPC client (or no-op if never initialized)
5. routeSelector.close?.() — close resolver gRPC client
6. app.close()           — stop accepting + drain in-flight
7. pool.end()            — close all Postgres connections
8. process.exit(0)
```

In-flight `/v1/*` streams get terminated by step 6's drain. The
client sees a half-finished SSE response. We accept this — see
[`streaming-usage.md`](./streaming-usage.md): mid-stream errors are
the streaming contract's known limitation.

## Why this ordering

- **Config first.** Anything else risks running with bad env.
- **DB before everything else.** The migrations need to land before
  any route handler can read its schema. A late migration means a
  brief 500 window for early traffic — not acceptable.
- **Payer + selector + email before listen.** They're prerequisites
  for `/v1/*`. We want daemon wiring failures to stop boot rather
  than degrade later at request time.
- **Refresh task after listen would be fine.** It's scheduled
  before listen for code simplicity (no awaitable promise to track)
  — `setInterval(...).unref()` means it doesn't block exit.

## Where it lives

| Concern | File |
|---|---|
| Boot orchestration | `gateway/src/index.ts` |
| Config validation | `gateway/src/config.ts` |
| Migration runner | `gateway/src/db.ts` |
| Fastify factory | `gateway/src/server.ts` |
| Payer init / shutdown | `gateway/src/proxy/livepeer/payment.ts` |
| Route selector lifecycle | `gateway/src/proxy/service/routeSelector.ts` |
| Refresh task lifecycle | `gateway/src/registry/refresh.ts` |
| Rate limiter lifecycle | `gateway/src/proxy/rateLimit.ts` |
