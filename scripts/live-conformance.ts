// Black-box paid-job/v1 conformance against a running OpenAI gateway.
//
// Exercises unary, stream, and multipart through the public API, then uses
// the caller's portal session to prove each durable reservation captured the
// broker's signed evidence and reached terminal LOC settlement.

import { randomUUID } from 'node:crypto';

const baseUrl = (process.env['OPENAI_BASE_URL'] ?? 'http://127.0.0.1:4001')
  .replace(/\/$/, '');
const apiKey = requiredEnv('OPENAI_API_KEY');
const chatModel = process.env['OPENAI_CHAT_MODEL'] ?? 'default';
const transcriptionModel = process.env['OPENAI_TRANSCRIPTION_MODEL'] ?? 'default';
const settlementTimeoutMs = positiveIntEnv('LIVE_SETTLEMENT_TIMEOUT_MS', 90_000);

interface UsageRow {
  id: string;
  capability: string;
  state: string;
  statusCode: number | null;
  locJobId: string | null;
  locRequestId: string | null;
  paymentWorkId: string | null;
  brokerJobId: string | null;
  jobProtocol: string | null;
  jobTransport: string | null;
  settlementLookupState: string | null;
  brokerActualUnits: string | null;
  brokerDebitedUnits: string | null;
  brokerBilledValueWei: string | null;
  brokerSettlementOutcome: string | null;
  settleState: string | null;
  settleAttempts: number;
  terminalEvidenceType: string | null;
}

interface UsageResponse {
  data: UsageRow[];
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  const health = await getJson(`${baseUrl}/health`);
  const healthRecord = record(health, 'health');
  if (healthRecord['status'] !== 'ok') fail('gateway health is not ok');
  pass('gateway, database, and LOC health are ok');

  const cookie = await portalLogin();
  const before = new Set((await listUsage(cookie)).map((row) => row.id));

  await runUnary();
  const unary = await waitForSettled(cookie, before, 'openai:chat-completions', 'unary');
  before.add(unary.id);

  await runStream();
  const stream = await waitForSettled(cookie, before, 'openai:chat-completions', 'stream');
  before.add(stream.id);

  await runMultipart();
  const multipart = await waitForSettled(
    cookie,
    before,
    'openai:audio-transcriptions',
    'multipart',
  );
  before.add(multipart.id);

  const finalHealth = record(await getJson(`${baseUrl}/health`), 'health');
  if (finalHealth['pendingSettlements'] !== 0) {
    fail(`gateway still reports ${String(finalHealth['pendingSettlements'])} pending settlements`);
  }
  pass('all transports settled and gateway reports zero pending settlements');
}

async function portalLogin(): Promise<string> {
  const response = await fetch(`${baseUrl}/portal/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) fail(`portal login returned HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0];
  if (!cookie) fail('portal login did not return a session cookie');
  pass('API key authenticated through the portal');
  return cookie;
}

async function runUnary(): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: 'user', content: `Return the word unary. ${randomUUID()}` }],
      max_tokens: 512,
    }),
  });
  await requireSuccess(response, 'unary chat');
  const body = record(await response.json(), 'unary chat response');
  if (typeof body['id'] !== 'string') fail('unary chat response has no id');
  pass('unary chat returned an OpenAI response');
}

async function runStream(): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: 'user', content: `Return the word stream. ${randomUUID()}` }],
      max_tokens: 512,
      stream: true,
    }),
  });
  await requireSuccess(response, 'streaming chat');
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    fail('streaming chat did not return text/event-stream');
  }
  if (!response.body) fail('streaming chat returned no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamText = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    streamText += decoder.decode(chunk.value, { stream: true });
  }
  streamText += decoder.decode();
  if (!streamText.includes('data:') || !streamText.includes('[DONE]')) {
    fail('streaming chat did not produce SSE data and [DONE]');
  }
  pass('streaming chat returned SSE through [DONE]');
}

async function runMultipart(): Promise<void> {
  const form = new FormData();
  form.append('model', transcriptionModel);
  form.append('file', new Blob([wavSeconds(3)], { type: 'audio/wav' }), 'exact-3s.wav');
  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  await requireSuccess(response, 'multipart transcription');
  const body = record(await response.json(), 'transcription response');
  if (typeof body['text'] !== 'string') fail('transcription response has no text');
  pass('exact 3-second WAV transcription returned an OpenAI response');
}

async function waitForSettled(
  cookie: string,
  before: Set<string>,
  capability: string,
  transport: string,
): Promise<UsageRow> {
  const deadline = Date.now() + settlementTimeoutMs;
  let observed: UsageRow | undefined;
  while (Date.now() < deadline) {
    const rows = await listUsage(cookie);
    observed = rows.find(
      (row) =>
        !before.has(row.id) &&
        row.capability === capability &&
        row.jobTransport === transport,
    );
    if (observed?.settleState === 'settled') {
      assertDurableSuccess(observed, capability, transport);
      pass(
        `${transport} evidence settled: actual=${observed.brokerActualUnits} ` +
          `${observed.capability === 'openai:audio-transcriptions' ? 'seconds' : 'tokens'}, ` +
          `billed=${observed.brokerBilledValueWei} wei`,
      );
      return observed;
    }
    if (observed?.settleState === 'failed' || observed?.terminalEvidenceType) {
      fail(
        `${transport} accounting terminated as ` +
          `${observed.terminalEvidenceType ?? observed.settleState}`,
      );
    }
    await delay(1_000);
  }
  return fail(
    `${transport} settlement did not complete in ${settlementTimeoutMs}ms` +
      (observed ? ` (last state ${observed.settlementLookupState}/${observed.settleState})` : ''),
  );
}

function assertDurableSuccess(row: UsageRow, capability: string, transport: string): void {
  if (row.state !== 'committed') fail(`${transport} reservation state is ${row.state}`);
  if (row.statusCode === null || row.statusCode < 200 || row.statusCode >= 300) {
    fail(`${transport} reservation has invalid HTTP status ${String(row.statusCode)}`);
  }
  if (row.jobProtocol !== 'paid-job/v1') fail(`${transport} did not persist paid-job/v1`);
  if (row.capability !== capability) fail(`${transport} capability drifted to ${row.capability}`);
  for (const [field, value] of [
    ['LOC job id', row.locJobId],
    ['LOC request id', row.locRequestId],
    ['payment work id', row.paymentWorkId],
    ['broker job id', row.brokerJobId],
    ['broker actual units', row.brokerActualUnits],
    ['broker debited units', row.brokerDebitedUnits],
    ['broker billed value', row.brokerBilledValueWei],
    ['broker settlement outcome', row.brokerSettlementOutcome],
  ] as const) {
    if (!value) fail(`${transport} did not persist ${field}`);
  }
  if (row.settlementLookupState !== 'ready') {
    fail(`${transport} signed settlement lookup is ${String(row.settlementLookupState)}`);
  }
  if (row.brokerActualUnits !== row.brokerDebitedUnits) {
    fail(`${transport} actual/debited unit drift`);
  }
  if (row.settleAttempts !== 0) fail(`${transport} required ${row.settleAttempts} settle retries`);
}

async function listUsage(cookie: string): Promise<UsageRow[]> {
  const value = record(
    await getJson(`${baseUrl}/portal/usage?limit=500`, { Cookie: cookie }),
    'portal usage',
  ) as unknown as UsageResponse;
  if (!Array.isArray(value.data)) fail('portal usage response has no data array');
  return value.data;
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  await requireSuccess(response, url);
  return await response.json();
}

async function requireSuccess(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = (await response.text()).slice(0, 500);
  fail(`${label} returned HTTP ${response.status}: ${text}`);
}

function authHeaders(contentType: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType };
}

function wavSeconds(seconds: number): ArrayBuffer {
  const sampleRate = 16_000;
  const frames = sampleRate * seconds;
  const dataSize = frames * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
