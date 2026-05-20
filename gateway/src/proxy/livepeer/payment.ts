// Mints `Livepeer-Payment` header values by calling
// PayerDaemon.CreatePayment over a unix-socket gRPC connection.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev fallback: from gateway/{src,dist}/proxy/livepeer/payment.ts, walk
// up four levels to the repo root and into proto/. Production callers
// should pass `opts.protoRoot` from config (resolves to /app/proto in
// the container).
const PROTO_ROOT = resolve(__dirname, "..", "..", "..", "..", "proto");

const PROTO_FILES = [
  "livepeer/payments/v1/types.proto",
  "livepeer/payments/v1/payer_daemon.proto",
];

interface PaymentWire {
  ticketParams?: {
    recipientRandHash?: Buffer | Uint8Array | string;
  };
}

interface PayerDaemonClient extends grpc.Client {
  createPayment(
    req: CreatePaymentRequest,
    cb: (err: grpc.ServiceError | null, resp: CreatePaymentResponse) => void,
  ): void;
  reportPaymentResult(
    req: ReportPaymentResultRequest,
    cb: (err: grpc.ServiceError | null, resp: ReportPaymentResultResponse) => void,
  ): void;
  health(
    req: Record<string, never>,
    cb: (err: grpc.ServiceError | null, resp: HealthResponse) => void,
  ): void;
}

interface BigUInt {
  value: Buffer;
}

interface QuoteRef {
  quoteId: string;
  quoteVersion: number;
  constraintFingerprint: Uint8Array;
  routeFingerprint: Uint8Array;
}

interface AcceptedPrice {
  pricePerUnitWei: BigUInt;
  unitsPerPrice: number;
  workUnitName: string;
  capability: string;
  offering: string;
  quoteRef: QuoteRef;
}

interface FundingIntent {
  estimatedUnits: number;
  fundedValueWei: BigUInt;
  maxTotalUnits: number;
  topUpAllowed: boolean;
}

interface CreatePaymentRequest {
  recipient: Buffer;
  ticketParamsBaseUrl?: string;
  acceptedPrice: AcceptedPrice;
  funding: FundingIntent;
}

interface CreatePaymentResponse {
  paymentBytes: Buffer;
  ticketsCreated: number;
  expectedValue: BigUInt;
  fundedValueWei: BigUInt;
  acceptedQuoteRef: QuoteRef;
  workId?: string;
  work_id?: string;
}

interface ReportPaymentResultRequest {
  workId: string;
  capability: string;
  offering: string;
  rejectionReason: string;
}

interface ReportPaymentResultResponse {
}

interface HealthResponse {
  status: string;
}

export interface PaymentRouteQuote {
  capability: string;
  offering: string;
  recipientHex: string;
  brokerUrl?: string;
  pricePerWorkUnitWei: string;
  workUnit: string;
  unitsPerPrice: number;
  quoteId: string;
  quoteVersion: number;
  constraintFingerprint: Uint8Array;
  routeFingerprint: Uint8Array;
}

export interface BuiltPayment {
  paymentBlob: string;
  workId?: string;
}

let cachedClient: PayerDaemonClient | null = null;
let paymentDeserializer: ((bytes: Buffer) => PaymentWire) | null = null;

interface InitOptions {
  socketPath: string;
  protoRoot?: string;
}

export async function init(opts: InitOptions): Promise<void> {
  if (cachedClient !== null) return;

  const def = await protoLoader.load(PROTO_FILES, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [opts.protoRoot ?? PROTO_ROOT],
  });
  const proto = grpc.loadPackageDefinition(def) as unknown as {
    livepeer: {
      payments: {
        v1: {
          PayerDaemon: grpc.ServiceClientConstructor;
          Payment: { deserialize: (bytes: Buffer) => PaymentWire };
        };
      };
    };
  };
  const ClientCtor = proto.livepeer.payments.v1.PayerDaemon;
  paymentDeserializer = proto.livepeer.payments.v1.Payment.deserialize;
  const client = new ClientCtor(
    `unix:${opts.socketPath}`,
    grpc.credentials.createInsecure(),
  ) as unknown as PayerDaemonClient;

  await new Promise<void>((res, rej) => {
    client.health({}, (err) => (err ? rej(err) : res()));
  });
  cachedClient = client;
}

export function shutdown(): void {
  if (cachedClient) {
    cachedClient.close();
    cachedClient = null;
  }
  paymentDeserializer = null;
}

export async function buildPayment(inputs: {
  route: PaymentRouteQuote;
  estimatedUnits: number;
}): Promise<string> {
  const built = await buildPaymentBundle(inputs);
  return built.paymentBlob;
}

export async function buildPaymentBundle(inputs: {
  route: PaymentRouteQuote;
  estimatedUnits: number;
}): Promise<BuiltPayment> {
  if (!cachedClient) {
    throw new Error("buildPayment: payer-daemon client not initialized; call init() first");
  }

  const estimatedUnits = Math.max(1, Math.floor(inputs.estimatedUnits));
  const unitsPerPrice = Math.max(1, Math.floor(inputs.route.unitsPerPrice || 1));
  const pricePerUnitWei = safeBigInt(inputs.route.pricePerWorkUnitWei);
  const fundedValueWei = ceilDivBigInt(BigInt(estimatedUnits), BigInt(unitsPerPrice)) * pricePerUnitWei;

  const req: CreatePaymentRequest = {
    recipient: hexToBuffer(inputs.route.recipientHex),
    ticketParamsBaseUrl: inputs.route.brokerUrl,
    acceptedPrice: {
      pricePerUnitWei: { value: bigintToBigEndian(pricePerUnitWei) },
      unitsPerPrice,
      workUnitName: inputs.route.workUnit,
      capability: inputs.route.capability,
      offering: inputs.route.offering,
      quoteRef: {
        quoteId: inputs.route.quoteId,
        quoteVersion: inputs.route.quoteVersion,
        constraintFingerprint: inputs.route.constraintFingerprint,
        routeFingerprint: inputs.route.routeFingerprint,
      },
    },
    funding: {
      estimatedUnits,
      fundedValueWei: { value: bigintToBigEndian(fundedValueWei) },
      maxTotalUnits: estimatedUnits,
      topUpAllowed: false,
    },
  };

  const resp = await new Promise<CreatePaymentResponse>((res, rej) => {
    cachedClient!.createPayment(req, (err, r) => (err ? rej(err) : res(r)));
  });
  const paymentBytes = Buffer.from(resp.paymentBytes);
  return {
    paymentBlob: paymentBytes.toString("base64"),
    workId: firstNonEmptyString(resp.workId, resp.work_id, deriveWorkId(paymentBytes)),
  };
}

export async function reportInvalidRecipientRand(inputs: {
  workId: string;
  capability: string;
  offering: string;
}): Promise<void> {
  if (!cachedClient) {
    throw new Error("reportInvalidRecipientRand: payer-daemon client not initialized; call init() first");
  }

  await new Promise<void>((res, rej) => {
    cachedClient!.reportPaymentResult(
      {
        workId: inputs.workId,
        capability: inputs.capability,
        offering: inputs.offering,
        rejectionReason: "PAYMENT_REJECTION_REASON_INVALID_RECIPIENT_RAND",
      },
      (err) => {
        if (!err) {
          res();
          return;
        }
        if (err.code === grpc.status.ABORTED) {
          res();
          return;
        }
        rej(err);
      },
    );
  });
}

function bigintToBigEndian(n: bigint): Buffer {
  if (n === 0n) return Buffer.alloc(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Buffer.from(bytes);
}

function hexToBuffer(hex: string): Buffer {
  const normalized = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(normalized)) {
    throw new Error(`invalid recipient hex address: ${hex}`);
  }
  return Buffer.from(normalized, "hex");
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function ceilDivBigInt(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function deriveWorkId(paymentBytes: Buffer): string | undefined {
  if (!paymentDeserializer) return undefined;
  try {
    const payment = paymentDeserializer(paymentBytes);
    const raw = payment.ticketParams?.recipientRandHash;
    const buf = toBuffer(raw);
    if (!buf || buf.length === 0) return undefined;
    return buf.toString("hex");
  } catch {
    return undefined;
  }
}

function toBuffer(raw: Buffer | Uint8Array | string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(raw, "base64");
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
