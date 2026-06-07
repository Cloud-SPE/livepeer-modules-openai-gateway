// Manual smoke test against a live LOC clearinghouse.
//
// Opens a tiny 1-unit job and immediately settles it with 0 units, so
// the only cost is transient: the estimate's expected value is charged
// at open and refunded in full at settle.
//
// Usage:
//   LOC_BASE_URL=https://loc.cloudspe.com LOC_API_KEY=... \
//     pnpm exec tsx scripts/loc-smoke.ts
// or: make loc-smoke (reads the same env / .env values)

import { createLocClient, LocApiError } from '../gateway/src/loc/client.js';

const baseUrl = process.env['LOC_BASE_URL'] ?? 'https://loc.cloudspe.com';
const apiKey = process.env['LOC_API_KEY'];

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

async function main(): Promise<void> {
  if (!apiKey) fail('LOC_API_KEY is not set');

  const loc = createLocClient({ baseUrl, apiKey, timeoutMs: 15000 });

  // ── 1. health ─────────────────────────────────────────────────
  const health = await loc.health();
  if (health.status !== 'ok') fail(`LOC health status: ${health.status}`);
  pass(`health ok — version ${health.version}, env ${health.env}`);

  // ── 2. balance (soft — the deployed LOC gates this behind the
  //      portal session cookie, not the API key) ─────────────────
  try {
    const balance = await loc.getBalance();
    pass(`balance: ${balance.amountWei} wei`);
  } catch (err) {
    if (err instanceof LocApiError && err.status === 401) {
      console.log(`- balance: skipped (requires portal session, got 401)`);
    } else {
      throw err;
    }
  }

  // ── 3. capabilities ───────────────────────────────────────────
  const capabilities = await loc.listCapabilities();
  const offerings = capabilities.flatMap((c) =>
    c.offerings.map((o) => ({ capability: c.name, offering: o.id })),
  );
  if (offerings.length === 0) fail('no capabilities/offerings advertised');
  pass(
    `capabilities: ${capabilities.length} (${offerings.length} offerings) — ` +
      capabilities
        .slice(0, 3)
        .map((c) => c.name)
        .join(', '),
  );

  // ── 4. open a 1-unit job ──────────────────────────────────────
  const target = offerings[0]!;
  let job;
  try {
    job = await loc.openJob({
      capability: target.capability,
      offering: target.offering,
      estimatedUnits: 1,
    });
  } catch (err) {
    if (err instanceof LocApiError) {
      fail(`openJob ${target.capability}/${target.offering}: ${err.code} — ${err.message}`);
    }
    throw err;
  }
  pass(
    `opened job ${job.jobId} (${target.capability}/${target.offering}, mode ${job.mode}, ` +
      `broker ${job.brokerUrl}, EV ${job.expectedValueWei} wei)`,
  );

  // ── 5. settle with 0 units (full refund) ──────────────────────
  const settled = await loc.settleJob(job.jobId, { actualUnits: 0, outcome: 'smoke' });
  pass(`settled job ${job.jobId}: billed ${settled.billedValueWei} wei, refund ${settled.refundWei} wei`);

  // ── 6. balance after round trip (soft, see step 2) ────────────
  try {
    const after = await loc.getBalance();
    pass(`balance after: ${after.amountWei} wei`);
  } catch (err) {
    if (err instanceof LocApiError && err.status === 401) {
      console.log(`- balance after: skipped (requires portal session, got 401)`);
    } else {
      throw err;
    }
  }

  console.log('\nLOC smoke: all checks passed.');
}

main().catch((err) => {
  if (err instanceof LocApiError) {
    fail(`LOC error ${err.status} ${err.code}: ${err.message}`);
  }
  console.error(err);
  process.exit(1);
});
