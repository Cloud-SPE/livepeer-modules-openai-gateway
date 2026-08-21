import { HEADER, PAID_JOB_PROTOCOL } from "./headers.js";
import { errorFromResponse } from "./errors.js";

export interface SendOpts {
  brokerUrl: string;
  capability: string;
  offering: string;
  paymentBlob: string;
  body: BodyInit | null;
  contentType?: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface SendResult {
  status: number;
  body: ArrayBuffer;
  headers: Headers;
  workUnits: number;
  workUnit: string | undefined;
  jobId: string | undefined;
  requestId: string;
}

export async function send(opts: SendOpts): Promise<SendResult> {
  const headers = new Headers();
  headers.set(HEADER.CAPABILITY, opts.capability);
  headers.set(HEADER.OFFERING, opts.offering);
  headers.set(HEADER.PAYMENT, opts.paymentBlob);
  headers.set(HEADER.PROTOCOL, PAID_JOB_PROTOCOL);
  headers.set(HEADER.REQUEST_ID, opts.requestId);
  if (opts.contentType) headers.set("Content-Type", opts.contentType);

  const url = new URL("/v1/job", opts.brokerUrl).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: opts.body,
    signal: opts.signal,
  });

  const respBody = await resp.arrayBuffer();
  if (resp.status >= 400) {
    throw errorFromResponse(resp.status, resp.headers, respBody);
  }

  const wuStr = resp.headers.get(HEADER.WORK_UNITS);
  const workUnits = wuStr ? parseInt(wuStr, 10) || 0 : 0;

  return {
    status: resp.status,
    body: respBody,
    headers: resp.headers,
    workUnits,
    workUnit: resp.headers.get(HEADER.WORK_UNIT) ?? undefined,
    jobId: resp.headers.get(HEADER.JOB_ID) ?? undefined,
    requestId: opts.requestId,
  };
}
