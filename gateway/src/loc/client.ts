// Typed HTTP client for the Livepeer Open Clearinghouse (LOC).
//
// The LOC fronts the service-registry and payer daemons: POST /v1/jobs
// selects a route AND mints the payment envelope in one call; the
// envelope goes verbatim into the `Livepeer-Payment` header. Jobs are
// charged at issuance for the full estimate — settling with actual
// units afterwards is what claws back the difference (see settler.ts).

export interface LocClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export class LocApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(opts: { status: number; code: string; message: string; details?: unknown }) {
    super(opts.message);
    this.name = 'LocApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details ?? null;
  }
}

export type JobTransport = 'unary' | 'stream' | 'multipart';

export interface OpenJobRequest {
  idempotencyKey: string;
  capability: string;
  offering: string;
  transport: JobTransport;
  estimatedUnits: number;
  maxTotalUnits?: number;
}

export interface OpenJobResponse {
  jobId: string;
  requestId: string;
  workId: string;
  brokerUrl: string;
  protocol: 'paid-job/v1';
  transport: JobTransport;
  workUnit: string;
  /** Base64 payment bytes — goes verbatim into the Livepeer-Payment header. */
  paymentEnvelope: string;
  expectedValueWei: string;
  fundedValueWei: string;
  settleEndpoint: string;
  openedAt: string;
}

export interface SettleJobRequest {
  actualUnits: number;
  brokerJobId: string;
  workUnit: string;
  outcome?: string;
  settlement: SettlementEnvelope;
}

export interface SettlementSignature {
  algorithm: 'secp256k1';
  canonicalization: 'jcs';
  value: string;
}

export interface SettlementEnvelope {
  payload: Record<string, unknown>;
  signature: SettlementSignature;
}

export interface LocCapStatus {
  sessionPctUsed: number;
  spendPeriodPctUsed: number | null;
  userBalancePctUsed: number | null;
  operatorPoolPctUsed: number | null;
  willRefuseNextRefill: boolean;
  winddownReason: string | null;
}

export interface SettleJobResponse {
  jobId: string;
  workId: string;
  actualUnits: number;
  billedValueWei: string;
  refundWei: string;
  outcome: string;
  closedAt: string;
  capStatus: LocCapStatus;
}

export interface LocOffering {
  id: string;
  pricePerWorkUnitWei: string | null;
  workUnit: string | null;
  protocol: string;
  transports: JobTransport[];
  /** Merged node+capability extra_json registry metadata (opaque JSON
   * object; e.g. extra.openai.model. Empty
   * object when the LOC predates the extra-exposure change. */
  extra: Record<string, unknown>;
}

export interface LocCapability {
  name: string;
  workUnit: string | null;
  offerings: LocOffering[];
}

export interface LocOrchestrator {
  ethAddress: string;
  workerUrl: string;
  capabilities: string[];
  signatureStatus: string;
  freshnessStatus: string;
}

export interface LocBalance {
  amountWei: string;
}

export interface LocHealth {
  status: string;
  version: string;
  env: string;
}

export interface LocClient {
  openJob(req: OpenJobRequest): Promise<OpenJobResponse>;
  settleJob(jobId: string, req: SettleJobRequest): Promise<SettleJobResponse>;
  listCapabilities(): Promise<LocCapability[]>;
  listOrchestrators(capability?: string): Promise<LocOrchestrator[]>;
  getBalance(): Promise<LocBalance>;
  health(): Promise<LocHealth>;
}

export function createLocClient(cfg: LocClientConfig): LocClient {
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    additionalHeaders?: Record<string, string>,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      'X-API-Key': cfg.apiKey,
      ...additionalHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let resp: Response;
    try {
      resp = await fetch(new URL(path, cfg.baseUrl), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new LocApiError({
        status: 0,
        code: 'loc_unreachable',
        message: `LOC request failed: ${(err as Error).message ?? 'network error'}`,
      });
    }

    const text = await resp.text();
    const parsed = safeJson(text);
    if (resp.status >= 400) {
      throw errorFromEnvelope(resp.status, parsed, text);
    }
    return parsed;
  };

  return {
    async openJob(req: OpenJobRequest): Promise<OpenJobResponse> {
      const estimatedUnits = requirePositiveSafeInteger(req.estimatedUnits, 'estimated_units');
      const maxTotalUnits =
        req.maxTotalUnits === undefined
          ? undefined
          : requirePositiveSafeInteger(req.maxTotalUnits, 'max_total_units');
      if (maxTotalUnits !== undefined && maxTotalUnits < estimatedUnits) {
        throw invalidContract('max_total_units must be greater than or equal to estimated_units');
      }
      const raw = asRecord(
        await call('POST', '/v1/jobs', {
          capability: req.capability,
          offering: req.offering,
          transport: req.transport,
          estimated_units: estimatedUnits,
          ...(maxTotalUnits !== undefined ? { max_total_units: maxTotalUnits } : {}),
        }, { 'Idempotency-Key': requireText(req.idempotencyKey, 'idempotency key') }),
      );
      const protocol = requireText(raw['protocol'], 'protocol');
      if (protocol !== 'paid-job/v1') {
        throw invalidContract(`unsupported protocol ${protocol}`);
      }
      const transport = requireTransport(raw['transport']);
      if (transport !== req.transport) {
        throw invalidContract(`transport drift: requested ${req.transport}, received ${transport}`);
      }
      const brokerUrl = requireUrl(raw['broker_url'], 'broker_url');
      const settleEndpoint = requireUrlOrPath(raw['settle_endpoint'], 'settle_endpoint');
      return {
        jobId: requireText(raw['job_id'], 'job_id'),
        requestId: requireText(raw['request_id'], 'request_id'),
        workId: requireText(raw['work_id'], 'work_id'),
        brokerUrl,
        protocol,
        transport,
        workUnit: requireText(raw['work_unit'], 'work_unit'),
        paymentEnvelope: requireText(raw['payment_envelope'], 'payment_envelope'),
        expectedValueWei: requireUnsignedIntegerText(raw['expected_value_wei'], 'expected_value_wei'),
        fundedValueWei: requireUnsignedIntegerText(raw['funded_value_wei'], 'funded_value_wei'),
        settleEndpoint,
        openedAt: requireTimestamp(raw['opened_at'], 'opened_at'),
      };
    },

    async settleJob(jobId: string, req: SettleJobRequest): Promise<SettleJobResponse> {
      const normalizedJobId = requireText(jobId, 'job id');
      const actualUnits = requireSafeUnsignedInteger(req.actualUnits, 'actual_units');
      const brokerJobId = requireText(req.brokerJobId, 'broker_job_id');
      const workUnit = requireText(req.workUnit, 'work_unit');
      const settlement = requireSettlementEnvelope(req.settlement);
      assertSettlementRequestMatches(settlement.payload, {
        actualUnits,
        brokerJobId,
        workUnit,
        ...(req.outcome !== undefined ? { outcome: requireText(req.outcome, 'outcome') } : {}),
      });
      const raw = asRecord(
        await call('POST', `/v1/jobs/${encodeURIComponent(normalizedJobId)}/settle`, {
          actual_units: actualUnits,
          broker_job_id: brokerJobId,
          work_unit: workUnit,
          ...(req.outcome !== undefined ? { outcome: req.outcome } : {}),
          settlement,
        }),
      );
      const responseJobId = requireText(raw['job_id'], 'job_id');
      if (responseJobId !== normalizedJobId) {
        throw invalidContract(`job identity drift: requested ${normalizedJobId}, received ${responseJobId}`);
      }
      const responseActualUnits = requireSafeUnsignedInteger(raw['actual_units'], 'actual_units');
      if (responseActualUnits !== actualUnits) {
        throw invalidContract(
          `settled unit drift: requested ${actualUnits}, received ${responseActualUnits}`,
        );
      }
      const payloadWorkId = requireText(settlement.payload['work_id'], 'settlement.payload.work_id');
      const responseWorkId = requireText(raw['work_id'], 'work_id');
      if (responseWorkId !== payloadWorkId) {
        throw invalidContract(
          `payment identity drift: settlement ${payloadWorkId}, received ${responseWorkId}`,
        );
      }
      return {
        jobId: responseJobId,
        workId: responseWorkId,
        actualUnits: responseActualUnits,
        billedValueWei: requireUnsignedIntegerText(raw['billed_value_wei'], 'billed_value_wei'),
        refundWei: requireUnsignedIntegerText(raw['refund_wei'], 'refund_wei'),
        outcome: requireText(raw['outcome'], 'outcome'),
        closedAt: requireTimestamp(raw['closed_at'], 'closed_at'),
        capStatus: requireCapStatus(raw['cap_status']),
      };
    },

    async listCapabilities(): Promise<LocCapability[]> {
      const raw = asRecord(await call('GET', '/v1/capabilities'));
      const items = Array.isArray(raw['items']) ? raw['items'] : [];
      return items.map((item) => {
        const cap = asRecord(item);
        const offerings = Array.isArray(cap['offerings']) ? cap['offerings'] : [];
        return {
          name: str(cap['name']),
          workUnit: strOrNull(cap['work_unit']),
          offerings: offerings.map((o) => {
            const off = asRecord(o);
            const job = asRecord(off['job']);
            return {
              id: str(off['id']),
              pricePerWorkUnitWei: strOrNull(off['price_per_work_unit_wei']),
              workUnit: strOrNull(off['work_unit']),
              protocol: str(off['protocol']),
              transports: parseJobTransports(job['transports']),
              extra: asRecord(off['extra']),
            };
          }),
        };
      });
    },

    async listOrchestrators(capability?: string): Promise<LocOrchestrator[]> {
      const qs = capability ? `?capability=${encodeURIComponent(capability)}` : '';
      const raw = asRecord(await call('GET', `/v1/orchestrators${qs}`));
      const items = Array.isArray(raw['items']) ? raw['items'] : [];
      return items.map((item) => {
        const orch = asRecord(item);
        return {
          ethAddress: str(orch['eth_address']),
          workerUrl: str(orch['worker_url']),
          capabilities: Array.isArray(orch['capabilities'])
            ? orch['capabilities'].map((c) => String(c))
            : [],
          signatureStatus: str(orch['signature_status']),
          freshnessStatus: str(orch['freshness_status']),
        };
      });
    },

    async getBalance(): Promise<LocBalance> {
      const raw = asRecord(await call('GET', '/v1/accounts/me/balance'));
      return { amountWei: str(raw['amount_wei']) };
    },

    async health(): Promise<LocHealth> {
      const raw = asRecord(await call('GET', '/health'));
      return {
        status: str(raw['status']),
        version: str(raw['version']),
        env: str(raw['env']),
      };
    },
  };
}

function parseJobTransports(value: unknown): JobTransport[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.some((item) => item !== 'unary' && item !== 'stream' && item !== 'multipart')) {
    throw new Error('LOC capability contains an unsupported paid-job transport');
  }
  return value as JobTransport[];
}

function requireText(value: unknown, field: string): string {
  const result = str(value).trim();
  if (!result) throw invalidContract(`missing ${field}`);
  return result;
}

function requireTransport(value: unknown): JobTransport {
  if (value === 'unary' || value === 'stream' || value === 'multipart') return value;
  throw invalidContract(`unsupported transport ${String(value)}`);
}

function requireUrl(value: unknown, field: string): string {
  const result = requireText(value, field);
  try {
    const url = new URL(result);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad scheme');
  } catch {
    throw invalidContract(`invalid ${field}`);
  }
  return result;
}

function requireUrlOrPath(value: unknown, field: string): string {
  const result = requireText(value, field);
  if (result.startsWith('/')) return result;
  return requireUrl(result, field);
}

function requireUnsignedIntegerText(value: unknown, field: string): string {
  const result = requireText(value, field);
  if (!/^\d+$/.test(result)) throw invalidContract(`invalid ${field}`);
  return result;
}

function requireSafeUnsignedInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidContract(`invalid ${field}`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const result = requireSafeUnsignedInteger(value, field);
  if (result === 0) throw invalidContract(`invalid ${field}`);
  return result;
}

function requireTimestamp(value: unknown, field: string): string {
  const result = requireText(value, field);
  if (Number.isNaN(Date.parse(result))) throw invalidContract(`invalid ${field}`);
  return result;
}

function requireSettlementEnvelope(value: unknown): SettlementEnvelope {
  const envelope = asRecord(value);
  assertExactKeys(envelope, ['payload', 'signature'], 'settlement');
  const payload = asRecord(envelope['payload']);
  if (Object.keys(payload).length === 0) throw invalidContract('missing settlement.payload');
  const signature = asRecord(envelope['signature']);
  assertExactKeys(signature, ['algorithm', 'canonicalization', 'value'], 'settlement.signature');
  if (signature['algorithm'] !== 'secp256k1') {
    throw invalidContract('unsupported settlement signature algorithm');
  }
  if (signature['canonicalization'] !== 'jcs') {
    throw invalidContract('unsupported settlement canonicalization');
  }
  const signatureValue = requireText(signature['value'], 'settlement.signature.value');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureValue)) {
    throw invalidContract('invalid settlement signature value');
  }
  return {
    payload,
    signature: {
      algorithm: 'secp256k1',
      canonicalization: 'jcs',
      value: signatureValue,
    },
  };
}

function assertSettlementRequestMatches(
  payload: Record<string, unknown>,
  request: { actualUnits: number; brokerJobId: string; workUnit: string; outcome?: string },
): void {
  const payloadActual = requireUnsignedIntegerText(payload['actual_units'], 'settlement.payload.actual_units');
  if (payloadActual !== String(request.actualUnits)) {
    throw invalidContract(
      `actual unit drift: request ${request.actualUnits}, settlement ${payloadActual}`,
    );
  }
  const payloadJobId = requireText(payload['job_id'], 'settlement.payload.job_id');
  if (payloadJobId !== request.brokerJobId) {
    throw invalidContract(
      `broker job identity drift: request ${request.brokerJobId}, settlement ${payloadJobId}`,
    );
  }
  const payloadWorkUnit = requireText(
    payload['work_unit_name'],
    'settlement.payload.work_unit_name',
  );
  if (payloadWorkUnit !== request.workUnit) {
    throw invalidContract(
      `work unit drift: request ${request.workUnit}, settlement ${payloadWorkUnit}`,
    );
  }
  if (request.outcome !== undefined) {
    const payloadOutcome = requireText(payload['outcome'], 'settlement.payload.outcome');
    if (payloadOutcome !== request.outcome) {
      throw invalidContract(
        `outcome drift: request ${request.outcome}, settlement ${payloadOutcome}`,
      );
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw invalidContract(`unexpected ${field} fields: ${extras.join(', ')}`);
}

function requireCapStatus(value: unknown): LocCapStatus {
  const raw = asRecord(value);
  return {
    sessionPctUsed: requireFraction(raw['session_pct_used'], 'cap_status.session_pct_used'),
    spendPeriodPctUsed: requireNullableFraction(
      raw['spend_period_pct_used'],
      'cap_status.spend_period_pct_used',
    ),
    userBalancePctUsed: requireNullableFraction(
      raw['user_balance_pct_used'],
      'cap_status.user_balance_pct_used',
    ),
    operatorPoolPctUsed: requireNullableFraction(
      raw['operator_pool_pct_used'],
      'cap_status.operator_pool_pct_used',
    ),
    willRefuseNextRefill: requireBoolean(
      raw['will_refuse_next_refill'],
      'cap_status.will_refuse_next_refill',
    ),
    winddownReason:
      raw['winddown_reason'] === null
        ? null
        : requireText(raw['winddown_reason'], 'cap_status.winddown_reason'),
  };
}

function requireFraction(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidContract(`invalid ${field}`);
  }
  return value;
}

function requireNullableFraction(value: unknown, field: string): number | null {
  return value === null ? null : requireFraction(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidContract(`invalid ${field}`);
  return value;
}

function invalidContract(message: string): LocApiError {
  return new LocApiError({ status: 502, code: 'loc_contract_invalid', message });
}

// ── error envelope parsing ──────────────────────────────────────────
// LOC responds with {"error":{"code","message","details"}}; some
// FastAPI surfaces use the legacy {"detail": "..."} shape.

function errorFromEnvelope(status: number, parsed: unknown, rawText: string): LocApiError {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const envelope = obj['error'];
    if (envelope && typeof envelope === 'object') {
      const e = envelope as Record<string, unknown>;
      return new LocApiError({
        status,
        code: typeof e['code'] === 'string' ? e['code'] : `http_${status}`,
        message: typeof e['message'] === 'string' ? e['message'] : rawText.slice(0, 200),
        details: e['details'],
      });
    }
    const detail = obj['detail'];
    if (detail !== undefined) {
      return new LocApiError({
        status,
        code: `http_${status}`,
        message: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200),
      });
    }
  }
  return new LocApiError({
    status,
    code: `http_${status}`,
    message: rawText.slice(0, 200) || `LOC returned HTTP ${status}`,
  });
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    const parseLosslessly = JSON.parse as (
      input: string,
      reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
    ) => unknown;
    return parseLosslessly(text, (_key, value, context) => {
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value) &&
        context.source !== undefined &&
        /^-?[0-9]+$/.test(context.source)
      ) {
        return context.source;
      }
      return value;
    });
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function strOrNull(value: unknown): string | null {
  const s = str(value);
  return s.length > 0 ? s : null;
}
