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

interface PayerDaemonClient extends grpc.Client {
  createPayment(
    req: CreatePaymentRequest,
    cb: (err: grpc.ServiceError | null, resp: CreatePaymentResponse) => void,
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

let cachedClient: PayerDaemonClient | null = null;

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
    livepeer: { payments: { v1: { PayerDaemon: grpc.ServiceClientConstructor } } };
  };
  const ClientCtor = proto.livepeer.payments.v1.PayerDaemon;
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
}

export async function buildPayment(inputs: {
  route: PaymentRouteQuote;
  estimatedUnits: number;
}): Promise<string> {
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
  return Buffer.from(resp.paymentBytes).toString("base64");
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
