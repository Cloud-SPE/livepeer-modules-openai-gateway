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

export type LocMode = 'http-reqresp@v0' | 'http-stream@v0' | 'http-multipart@v0';

export interface OpenJobRequest {
  capability: string;
  offering: string;
  estimatedUnits: number;
  maxTotalUnits?: number;
}

export interface OpenJobResponse {
  jobId: string;
  workId: string;
  brokerUrl: string;
  mode: string;
  /** Base64 payment bytes — goes verbatim into the Livepeer-Payment header. */
  paymentEnvelope: string;
  expectedValueWei: string;
  fundedValueWei: string;
  settleEndpoint: string;
  openedAt: string;
}

export interface SettleJobRequest {
  actualUnits: number;
  outcome?: string;
  settlement?: Record<string, unknown>;
}

export interface SettleJobResponse {
  jobId: string;
  workId: string;
  actualUnits: number;
  billedValueWei: string;
  refundWei: string;
  outcome: string;
  closedAt: string;
}

export interface LocOffering {
  id: string;
  pricePerWorkUnitWei: string | null;
  workUnit: string | null;
  /** Merged node+capability extra_json registry metadata (opaque JSON
   * object; e.g. extra.openai.model, extra.interaction_mode). Empty
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
  ): Promise<unknown> => {
    const headers: Record<string, string> = { 'X-API-Key': cfg.apiKey };
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
      const raw = asRecord(
        await call('POST', '/v1/jobs', {
          capability: req.capability,
          offering: req.offering,
          estimated_units: req.estimatedUnits,
          ...(req.maxTotalUnits !== undefined ? { max_total_units: req.maxTotalUnits } : {}),
        }),
      );
      return {
        jobId: str(raw['job_id']),
        workId: str(raw['work_id']),
        brokerUrl: str(raw['broker_url']),
        mode: str(raw['mode']),
        paymentEnvelope: str(raw['payment_envelope']),
        expectedValueWei: str(raw['expected_value_wei']),
        fundedValueWei: str(raw['funded_value_wei']),
        settleEndpoint: str(raw['settle_endpoint']),
        openedAt: str(raw['opened_at']),
      };
    },

    async settleJob(jobId: string, req: SettleJobRequest): Promise<SettleJobResponse> {
      const raw = asRecord(
        await call('POST', `/v1/jobs/${encodeURIComponent(jobId)}/settle`, {
          actual_units: req.actualUnits,
          ...(req.outcome !== undefined ? { outcome: req.outcome } : {}),
          ...(req.settlement !== undefined ? { settlement: req.settlement } : {}),
        }),
      );
      return {
        jobId: str(raw['job_id']),
        workId: str(raw['work_id']),
        actualUnits: num(raw['actual_units']),
        billedValueWei: str(raw['billed_value_wei']),
        refundWei: str(raw['refund_wei']),
        outcome: str(raw['outcome']),
        closedAt: str(raw['closed_at']),
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
            return {
              id: str(off['id']),
              pricePerWorkUnitWei: strOrNull(off['price_per_work_unit_wei']),
              workUnit: strOrNull(off['work_unit']),
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
    return JSON.parse(text);
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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
