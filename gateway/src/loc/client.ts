// LOC owns wholesale funding, route selection and spend authorization.
// Exact request commitments bind each invocation; only signed broker evidence
// authorizes settlement. Status observations remain a separate authority.

export interface LocClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  jobOpenTimeoutMs?: number;
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
  workloadRequestDigest: string;
  callerPublicKey: string;
}

export interface OpenJobResponse {
  jobId: string;
  requestId: string;
  workId: string;
  brokerUrl: string;
  protocol: 'paid-job/v1';
  transport: JobTransport;
  workUnit: string;
  spendAuthorization: string;
  accountingMode: 'wholesale_account';
  routeSnapshot: RouteSnapshot;
  expectedValueWei: string;
  fundedValueWei: string;
  settleEndpoint: string;
  openedAt: string;
}

export interface RouteSnapshot extends Record<string, unknown> {
  broker_url: string;
  eth_address: string;
  capability: string;
  offering: string;
  protocol: 'paid-job/v1';
  work_unit: string;
  price_per_work_unit_wei: string;
  units_per_price: number;
  quote_id: string;
  quote_version: number;
  constraint_fingerprint: string;
  route_fingerprint: string;
  settlement_domain_id: string;
  settlement_keys: unknown[];
}

export interface JobStatus {
  jobId: string;
  requestId: string;
  workId: string;
  state: string;
  accountingOutcome: 'unresolved' | 'non_admission_audit' | 'broker_settled' | 'conservative_full_charge';
  actualUnits: string | null;
  billedValueWei: string | null;
  closedAt: string | null;
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
  unitsPerPrice: number;
  workUnit: string | null;
  estimator?: LocWorkUnitEstimator;
  protocol: string;
  transports: JobTransport[];
  /** Merged node+capability extra_json registry metadata (opaque JSON
   * object; e.g. extra.openai.model. Empty
   * object when the LOC predates the extra-exposure change. */
  extra: Record<string, unknown>;
}

export interface LocWorkUnitEstimator {
  id: string;
  rounding: string;
  exactness: string;
  fixtures: string | null;
}

export interface LocCapability {
  name: string;
  workUnit: string | null;
  estimator?: LocWorkUnitEstimator;
  offerings: LocOffering[];
}

/** LOC discovery metadata; absence is not evidence of a complete catalog. */
export interface LocCatalogMetadata {
  completeness: 'UNINITIALIZED' | 'PARTIAL' | 'COMPLETE';
  stale: boolean;
  coverage: Record<string, number>;
  snapshot_at: string | null;
  evaluated_at: string;
  discovery_scope: string;
  discovery_scope_authoritative: boolean;
  discovery_observed_at: string | null;
  discovery_valid_until: string | null;
  coverage_valid_until: string | null;
}

export interface LocCapabilityCatalog {
  items: LocCapability[];
  catalog: LocCatalogMetadata | null;
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
  getJob(jobId: string): Promise<JobStatus>;
  settleJob(settleEndpoint: string, jobId: string, req: SettleJobRequest): Promise<SettleJobResponse>;
  listCapabilities(): Promise<LocCapabilityCatalog>;
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
    timeoutMs = cfg.timeoutMs,
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
        redirect: 'error',
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
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
          workload_request_digest: requirePattern(req.workloadRequestDigest, /^[0-9a-f]{64}$/, 'workload_request_digest'),
          caller_public_key: requirePattern(req.callerPublicKey, /^(02|03)[0-9a-f]{64}$/, 'caller_public_key'),
          ...(maxTotalUnits !== undefined ? { max_total_units: maxTotalUnits } : {}),
        }, { 'Idempotency-Key': requireText(req.idempotencyKey, 'idempotency key') }, cfg.jobOpenTimeoutMs ?? 90_000),
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
      const settleEndpoint = requireLocEndpoint(
        raw['settle_endpoint'],
        'settle_endpoint',
        cfg.baseUrl,
      );
      if (raw['accounting_mode'] !== 'wholesale_account') throw invalidContract('unsupported accounting_mode');
      const routeSnapshot = parseRouteSnapshot(raw['route_snapshot']);
      if (routeSnapshot.broker_url !== brokerUrl || routeSnapshot.capability !== req.capability ||
          routeSnapshot.offering !== req.offering || routeSnapshot.work_unit !== raw['work_unit']) {
        throw invalidContract('route snapshot does not match job');
      }
      return {
        jobId: requireText(raw['job_id'], 'job_id'),
        requestId: requireText(raw['request_id'], 'request_id'),
        workId: requireText(raw['work_id'], 'work_id'),
        brokerUrl,
        protocol,
        transport,
        workUnit: requireText(raw['work_unit'], 'work_unit'),
        spendAuthorization: requireText(raw['spend_authorization'], 'spend_authorization'),
        accountingMode: 'wholesale_account',
        routeSnapshot,
        expectedValueWei: requireUnsignedIntegerText(raw['expected_value_wei'], 'expected_value_wei'),
        fundedValueWei: requireUnsignedIntegerText(raw['funded_value_wei'], 'funded_value_wei'),
        settleEndpoint,
        openedAt: requireTimestamp(raw['opened_at'], 'opened_at'),
      };
    },

    async getJob(jobId: string): Promise<JobStatus> {
      const raw = asRecord(await call('GET', `/v1/jobs/${encodeURIComponent(jobId)}`));
      if (raw['job_id'] !== jobId) throw invalidContract('LOC job status identity drift');
      const outcome = requireText(raw['accounting_outcome'], 'accounting_outcome');
      if (!['unresolved', 'non_admission_audit', 'broker_settled', 'conservative_full_charge'].includes(outcome)) {
        throw invalidContract('unsupported LOC accounting outcome');
      }
      return {
        jobId, requestId: requireText(raw['request_id'], 'request_id'),
        workId: requireText(raw['work_id'], 'work_id'), state: requireText(raw['state'], 'state'),
        accountingOutcome: outcome as JobStatus['accountingOutcome'],
        actualUnits: raw['actual_units'] == null ? null : requireUnsignedIntegerText(raw['actual_units'], 'actual_units'),
        billedValueWei: raw['billed_value_wei'] == null ? null : requireUnsignedIntegerText(raw['billed_value_wei'], 'billed_value_wei'),
        closedAt: raw['closed_at'] == null ? null : requireTimestamp(raw['closed_at'], 'closed_at'),
      };
    },

    async settleJob(
      settleEndpoint: string,
      jobId: string,
      req: SettleJobRequest,
    ): Promise<SettleJobResponse> {
      const normalizedSettleEndpoint = requireLocEndpoint(
        settleEndpoint,
        'settle_endpoint',
        cfg.baseUrl,
      );
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
        await call('POST', normalizedSettleEndpoint, {
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

    async listCapabilities(): Promise<LocCapabilityCatalog> {
      const raw = asRecord(await call('GET', '/v1/capabilities'));
      if (!Array.isArray(raw['items'])) throw invalidContract('missing capability items');
      const catalog = parseCatalogMetadata(raw['catalog']);
      const items = raw['items'];
      return { catalog, items: items.map((item) => {
        const cap = asRecord(item);
        const offerings = Array.isArray(cap['offerings']) ? cap['offerings'] : [];
        const capabilityEstimator = parseWorkUnitEstimator(cap['work_unit_estimator']);
        return {
          name: str(cap['name']),
          workUnit: strOrNull(cap['work_unit']),
          ...(capabilityEstimator ? { estimator: capabilityEstimator } : {}),
          offerings: offerings.map((o) => {
            const off = asRecord(o);
            const job = asRecord(off['job']);
            const estimator = parseWorkUnitEstimator(off['work_unit_estimator']);
            return {
              id: str(off['id']),
              pricePerWorkUnitWei: strOrNull(off['price_per_work_unit_wei']),
              unitsPerPrice: requirePositiveSafeInteger(Number(requireUnsignedIntegerText(off['units_per_price'], 'units_per_price')), 'units_per_price'),
              workUnit: strOrNull(off['work_unit']),
              ...(estimator ? { estimator } : {}),
              protocol: str(off['protocol']),
              transports: parseJobTransports(job['transports']),
              extra: asRecord(off['extra']),
            };
          }),
        };
      }) };
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
            ? orch['capabilities'].map((c) => typeof c === 'string' ? c : str(asRecord(c)['name']))
            : [],
          signatureStatus: str(orch['signature_status']),
          freshnessStatus: str(orch['freshness_status']),
        };
      });
    },

    async getBalance(): Promise<LocBalance> {
      const raw = asRecord(await call('GET', '/v1/accounts/me/usage/overview'));
      return { amountWei: requireUnsignedIntegerText(raw['available_wei'], 'available_wei') };
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

function parseCatalogMetadata(value: unknown): LocCatalogMetadata | null {
  if (value == null) return null;
  const raw = asRecord(value);
  const completeness = raw['completeness'];
  if (completeness !== 'COMPLETE' && completeness !== 'PARTIAL' && completeness !== 'UNINITIALIZED') {
    throw invalidContract('invalid catalog completeness');
  }
  const coverage: Record<string, number> = {};
  for (const [key, count] of Object.entries(asRecord(raw['coverage']))) {
    coverage[key] = requireSafeUnsignedInteger(count, `catalog.coverage.${key}`);
  }
  const timestamp = (key: string): string | null =>
    raw[key] == null ? null : requireTimestamp(raw[key], `catalog.${key}`);
  return {
    completeness,
    stale: requireBoolean(raw['stale'], 'catalog.stale'),
    coverage,
    snapshot_at: timestamp('snapshot_at'),
    evaluated_at: requireTimestamp(raw['evaluated_at'], 'catalog.evaluated_at'),
    discovery_scope: requireText(raw['discovery_scope'], 'catalog.discovery_scope'),
    discovery_scope_authoritative: requireBoolean(raw['discovery_scope_authoritative'], 'catalog.discovery_scope_authoritative'),
    discovery_observed_at: timestamp('discovery_observed_at'),
    discovery_valid_until: timestamp('discovery_valid_until'),
    coverage_valid_until: timestamp('coverage_valid_until'),
  };
}

function parseWorkUnitEstimator(value: unknown): LocWorkUnitEstimator | null {
  if (value === undefined || value === null) return null;
  const estimator = asRecord(value);
  return {
    id: requireText(estimator['id'], 'work_unit_estimator.id'),
    rounding: requireText(estimator['rounding'], 'work_unit_estimator.rounding'),
    exactness: requireText(estimator['exactness'], 'work_unit_estimator.exactness'),
    fixtures: strOrNull(estimator['fixtures']),
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

function requireLocEndpoint(value: unknown, field: string, baseUrl: string): string {
  const result = requireText(value, field);
  if (result.startsWith('/')) return result;
  const endpoint = requireUrl(result, field);
  if (new URL(endpoint).origin !== new URL(baseUrl).origin) {
    throw invalidContract(`${field} must use the LOC origin`);
  }
  return endpoint;
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
  const payloadActual = requireUnsignedIntegerText(payload['actual_units'] === undefined ? '0' : payload['actual_units'], 'settlement.payload.actual_units');
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

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  const text = requireText(value, field);
  if (!pattern.test(text)) throw invalidContract(`invalid ${field}`);
  return text;
}

function parseRouteSnapshot(value: unknown): RouteSnapshot {
  const r = asRecord(value);
  if (r['schema_version'] !== 'route-snapshot/v1' || r['protocol'] !== 'paid-job/v1') {
    throw invalidContract('unsupported route snapshot');
  }
  const domain = requirePattern(r['settlement_domain_id'], /^0x[0-9a-f]{64}$/, 'settlement_domain_id');
  if (BigInt(domain) === 0n) throw invalidContract('zero settlement domain');
  if (!Array.isArray(r['settlement_keys']) || r['settlement_keys'].length === 0) throw invalidContract('missing settlement keys');
  return {
    ...r, broker_url: requireUrl(r['broker_url'], 'route broker_url'),
    eth_address: requirePattern(r['eth_address'], /^0x[0-9a-fA-F]{40}$/, 'eth_address'),
    capability: requireText(r['capability'], 'capability'), offering: requireText(r['offering'], 'offering'),
    protocol: 'paid-job/v1', work_unit: requireText(r['work_unit'], 'work_unit'),
    price_per_work_unit_wei: requireUnsignedIntegerText(r['price_per_work_unit_wei'], 'price'),
    units_per_price: requirePositiveSafeInteger(Number(requireUnsignedIntegerText(r['units_per_price'], 'units_per_price')), 'units_per_price'),
    quote_id: requireText(r['quote_id'], 'quote_id'),
    quote_version: requirePositiveSafeInteger(Number(requireUnsignedIntegerText(r['quote_version'], 'quote_version')), 'quote_version'),
    constraint_fingerprint: requirePattern(r['constraint_fingerprint'], /^[0-9a-f]{64}$/, 'constraint_fingerprint'),
    route_fingerprint: requirePattern(r['route_fingerprint'], /^[0-9a-f]{64}$/, 'route_fingerprint'),
    settlement_domain_id: domain, settlement_keys: r['settlement_keys'],
  };
}
