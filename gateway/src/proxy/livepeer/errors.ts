import { HEADER } from "./headers.js";

export class LivepeerBrokerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly backoffSeconds: number | undefined;
  readonly requestId: string | undefined;
  readonly jobId: string | undefined;
  readonly workUnit: string | undefined;
  readonly workUnits: string | undefined;
  readonly responseBody: string;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    backoffSeconds?: number;
    requestId?: string;
    jobId?: string;
    workUnit?: string;
    workUnits?: string;
    responseBody?: string;
  }) {
    super(opts.message);
    this.name = "LivepeerBrokerError";
    this.status = opts.status;
    this.code = opts.code;
    this.backoffSeconds = opts.backoffSeconds;
    this.requestId = opts.requestId;
    this.jobId = opts.jobId;
    this.workUnit = opts.workUnit;
    this.workUnits = opts.workUnits;
    this.responseBody = opts.responseBody ?? "";
  }
}

export function errorFromResponse(
  status: number,
  headers: Headers | Record<string, string | string[] | undefined>,
  body: ArrayBuffer | Uint8Array | string,
): LivepeerBrokerError {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    const raw = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };

  const code = get(HEADER.ERROR) ?? "unknown";
  const requestId = get(HEADER.REQUEST_ID);
  const jobId = get(HEADER.JOB_ID);
  const workUnit = get(HEADER.WORK_UNIT);
  const workUnits = get(HEADER.WORK_UNITS);
  const backoffStr = get(HEADER.BACKOFF);
  let backoffSeconds: number | undefined;
  if (backoffStr) {
    const n = parseInt(backoffStr, 10);
    if (!Number.isNaN(n)) backoffSeconds = n;
  }

  const bodyStr =
    typeof body === "string"
      ? body
      : new TextDecoder().decode(body instanceof Uint8Array ? body : body);

  let message = `broker error: ${code}`;
  try {
    const parsed = JSON.parse(bodyStr) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // body not JSON
  }

  return new LivepeerBrokerError({
    status,
    code,
    message,
    backoffSeconds,
    requestId,
    jobId,
    workUnit,
    workUnits,
    responseBody: bodyStr,
  });
}
