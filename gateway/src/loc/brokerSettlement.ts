import type { PendingSettlementLookup, SettlementEvidence } from '../repo/usageReservations.js';

export class BrokerSettlementContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerSettlementContractError';
  }
}

export type BrokerSettlementLookup =
  | { kind: 'evidence'; evidence: SettlementEvidence }
  | { kind: 'deferred'; state: 'accounting_pending' | 'in_flight' | 'no_record'; detail: string }
  | {
      kind: 'terminal_evidence';
      state: 'not_admitted' | 'evidence_expired';
      detail: string;
      encoded: string | null;
    };

export async function lookupBrokerSettlement(
  row: PendingSettlementLookup,
  timeoutMs: number,
): Promise<BrokerSettlementLookup> {
  const path = row.brokerJobId
    ? `/v1/settlement/${encodeURIComponent(row.brokerJobId)}`
    : `/v1/exchange/${encodeURIComponent(row.locRequestId)}`;
  let response: Response;
  try {
    response = await fetch(new URL(path, row.brokerUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`broker settlement lookup failed: ${(error as Error).message}`);
  }

  const rawBody = await response.text();
  const body = parseObject(rawBody);
  const outcome = optionalText(body['outcome']);
  const state = optionalText(body['state']);

  if (response.status === 202) {
    const accountingPending =
      outcome === 'ACCOUNTING_PENDING' || state === 'accounting_pending';
    return {
      kind: 'deferred',
      state: accountingPending ? 'accounting_pending' : 'in_flight',
      detail: accountingPending
        ? `broker debit pending after ${optionalInteger(body['debit_attempts']) ?? 0} attempts`
        : 'broker exchange remains in flight',
    };
  }

  if (response.status === 404 || response.status === 401) {
    return {
      kind: 'deferred',
      state: 'no_record',
      detail: outcome === 'NO_RECORD' ? optionalText(body['detail']) ?? 'broker has no record' : 'broker record unavailable',
    };
  }
  if (response.status >= 500) {
    throw new Error(`broker settlement lookup returned HTTP ${response.status}`);
  }
  if (response.status !== 200) {
    throw new BrokerSettlementContractError(
      `broker settlement lookup returned unexpected HTTP ${response.status}`,
    );
  }

  if (outcome === 'NOT_ADMITTED') {
    return {
      kind: 'terminal_evidence',
      state: 'not_admitted',
      detail: 'broker signed NOT_ADMITTED; retained as audit evidence only',
      encoded: requireText(body['non_admission'], 'non_admission'),
    };
  }
  if (outcome === 'ADMITTED_EVIDENCE_EXPIRED') {
    return {
      kind: 'terminal_evidence',
      state: 'evidence_expired',
      detail: optionalText(body['detail']) ?? 'broker admitted the exchange but detailed evidence expired',
      encoded: null,
    };
  }

  const encoded = requireText(body['settlement'], 'settlement');
  const parsed = decodeSignedSettlement(encoded);
  const responseJobId = requireText(body['job_id'], 'job_id');
  const responseUnit = requireText(body['unit'], 'unit');
  if (responseJobId !== parsed.brokerJobId) {
    throw new BrokerSettlementContractError(
      `lookup job_id ${responseJobId} does not match signed ${parsed.brokerJobId}`,
    );
  }
  if (responseUnit !== parsed.workUnit) {
    throw new BrokerSettlementContractError(
      `lookup unit ${responseUnit} does not match signed ${parsed.workUnit}`,
    );
  }
  return {
    kind: 'evidence',
    evidence: { encoded, ...parsed },
  };
}

export function decodeSignedSettlement(
  encoded: string,
): Omit<SettlementEvidence, 'encoded'> {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64');
  } catch {
    throw new BrokerSettlementContractError('settlement is not valid base64');
  }
  if (decoded.length === 0 || normalizeBase64(decoded.toString('base64')) !== normalizeBase64(encoded)) {
    throw new BrokerSettlementContractError('settlement is not canonical base64');
  }
  const envelopeRecord = parseObject(decoded.toString('utf8'));
  assertExactKeys(envelopeRecord, ['payload', 'signature'], 'settlement envelope');
  const payload = requireObject(envelopeRecord['payload'], 'settlement payload');
  const signature = requireObject(envelopeRecord['signature'], 'settlement signature');
  assertExactKeys(signature, ['algorithm', 'canonicalization', 'value'], 'settlement signature');
  if (signature['algorithm'] !== 'secp256k1' || signature['canonicalization'] !== 'jcs') {
    throw new BrokerSettlementContractError('unsupported settlement signature scheme');
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(requireText(signature['value'], 'signature value'))) {
    throw new BrokerSettlementContractError('invalid settlement signature value');
  }

  return {
    envelope: envelopeRecord,
    requestId: requireText(payload['request_id'], 'payload.request_id'),
    brokerJobId: requireText(payload['job_id'], 'payload.job_id'),
    paymentWorkId: requireText(payload['work_id'], 'payload.work_id'),
    workUnit: requireText(payload['work_unit_name'], 'payload.work_unit_name'),
    actualUnits: requireUnsignedInteger(payload['actual_units'], 'payload.actual_units'),
    debitedUnits: requireUnsignedInteger(payload['debited_units'], 'payload.debited_units'),
    billedValueWei: decodeBigUInt(payload['billed_value_wei'], 'payload.billed_value_wei'),
    outcome: requireText(payload['outcome'], 'payload.outcome'),
  };
}

function decodeBigUInt(value: unknown, field: string): string {
  const object = requireObject(value, field);
  const bytes = requireText(object['value'], `${field}.value`);
  const decoded = Buffer.from(bytes, 'base64');
  if (normalizeBase64(decoded.toString('base64')) !== normalizeBase64(bytes)) {
    throw new BrokerSettlementContractError(`invalid ${field}.value`);
  }
  return decoded.length === 0 ? '0' : BigInt(`0x${decoded.toString('hex')}`).toString(10);
}

function parseObject(text: string): Record<string, unknown> {
  try {
    return requireObject(JSON.parse(text), 'JSON body');
  } catch (error) {
    if (error instanceof BrokerSettlementContractError) throw error;
    throw new BrokerSettlementContractError('broker returned malformed JSON');
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerSettlementContractError(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrokerSettlementContractError(`missing ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireUnsignedInteger(value: unknown, field: string): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new BrokerSettlementContractError(`invalid ${field}`);
  }
  return text;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  if (extras.length > 0) {
    throw new BrokerSettlementContractError(`unexpected ${field} fields: ${extras.join(', ')}`);
  }
}

function normalizeBase64(value: string): string {
  return value.replace(/=+$/, '');
}
