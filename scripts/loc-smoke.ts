// Real paid-job/v1 smoke against LOC and its selected broker.
//
// This performs a paid exchange: idempotent LOC open, broker execution,
// signed settlement retrieval, and signed LOC settlement. It never fabricates
// zero usage and never submits unsigned evidence.

import { randomUUID } from 'node:crypto';

import {
  createLocClient,
  LocApiError,
  type SettlementEnvelope,
} from '../gateway/src/loc/client.js';
import { dispatchReqresp } from '../gateway/src/loc/dispatch.js';
import { lookupBrokerSettlement } from '../gateway/src/loc/brokerSettlement.js';

const baseUrl = requiredEnv('LOC_BASE_URL');
const apiKey = requiredEnv('LOC_API_KEY');
const capability = process.env['LOC_SMOKE_CAPABILITY'] ?? 'openai:chat-completions';
const offering = process.env['LOC_SMOKE_OFFERING'] ?? 'default';
const lookupAttempts = positiveIntEnv('LOC_SMOKE_LOOKUP_ATTEMPTS', 60);
const estimatedUnits = positiveIntEnv('LOC_SMOKE_ESTIMATED_UNITS', 64);
const maxTotalUnits = positiveIntEnv('LOC_SMOKE_MAX_TOTAL_UNITS', 256);

if (maxTotalUnits < estimatedUnits) {
  fail('LOC_SMOKE_MAX_TOTAL_UNITS must be greater than or equal to LOC_SMOKE_ESTIMATED_UNITS');
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  const loc = createLocClient({ baseUrl, apiKey, timeoutMs: 15_000 });
  const health = await loc.health();
  if (health.status !== 'ok') fail(`LOC health status: ${health.status}`);
  pass(`LOC health ok — version ${health.version}, env ${health.env}`);

  const capabilities = await loc.listCapabilities();
  const selected = capabilities
    .find((item) => item.name === capability)
    ?.offerings.find((item) => item.id === offering);
  if (!selected) fail(`catalog does not advertise ${capability}/${offering}`);
  if (selected.protocol !== 'paid-job/v1') {
    fail(`catalog protocol is ${selected.protocol || '<missing>'}, expected paid-job/v1`);
  }
  if (!selected.transports.includes('unary')) {
    fail(`${capability}/${offering} does not advertise unary transport`);
  }
  pass(`catalog advertises ${capability}/${offering} as paid-job/v1 unary`);

  const dispatched = await dispatchReqresp({
    loc,
    capability,
    offering,
    estimatedUnits,
    maxTotalUnits,
    idempotencyKey: randomUUID(),
    maxJobAttempts: 3,
    body: JSON.stringify({
      model: offering,
      messages: [{ role: 'user', content: 'Return the word smoke.' }],
      max_tokens: 64,
    }),
    contentType: 'application/json',
  });
  if (dispatched.result.status < 200 || dispatched.result.status >= 300) {
    fail(`broker returned HTTP ${dispatched.result.status}`);
  }
  pass(
    `broker admitted ${dispatched.jobRef.brokerJobId} for LOC job ${dispatched.jobRef.jobId}`,
  );

  const evidence = await waitForEvidence(dispatched.jobRef);
  const actualUnits = Number(evidence.actualUnits);
  if (!Number.isSafeInteger(actualUnits)) fail('signed actual units exceed the gateway safe range');
  const settled = await loc.settleJob(
    dispatched.jobRef.settleEndpoint,
    dispatched.jobRef.jobId,
    {
      actualUnits,
      brokerJobId: evidence.brokerJobId,
      workUnit: evidence.workUnit,
      outcome: evidence.outcome,
      settlement: evidence.envelope as unknown as SettlementEnvelope,
    },
  );
  pass(
    `LOC settled signed ${evidence.outcome}: actual=${settled.actualUnits} ` +
      `${evidence.workUnit}, billed=${settled.billedValueWei} wei, refund=${settled.refundWei} wei`,
  );
}

async function waitForEvidence(job: {
  brokerUrl: string;
  brokerJobId: string;
  requestId: string;
  workId: string;
  workUnit: string;
}) {
  for (let attempt = 1; attempt <= lookupAttempts; attempt++) {
    const result = await lookupBrokerSettlement(
      {
        id: 'smoke',
        brokerUrl: job.brokerUrl,
        brokerJobId: job.brokerJobId,
        locRequestId: job.requestId,
        paymentWorkId: job.workId,
        workUnit: job.workUnit,
        attempts: attempt - 1,
      },
      15_000,
    );
    if (result.kind === 'evidence') return result.evidence;
    if (result.kind === 'terminal_evidence') {
      fail(`broker returned ${result.state}: ${result.detail}`);
    }
    if (attempt < lookupAttempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return fail(`signed settlement did not become available after ${lookupAttempts} attempts`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  return value || fail(`${name} is not set`);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : fail(`${name} must be a positive integer`);
}

main().catch((error) => {
  if (error instanceof LocApiError) {
    fail(`LOC error ${error.status} ${error.code}: ${error.message}`);
  }
  console.error(error);
  process.exit(1);
});
