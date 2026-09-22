// Current paid-job/v1 invocation and evidence headers (network protocol 4).

export const HEADER = {
  CAPABILITY: "Livepeer-Capability",
  OFFERING: "Livepeer-Offering",
  AUTHORIZATION: "Livepeer-Authorization",
  CALLER_PROOF: "Livepeer-Caller-Proof",
  PROTOCOL: "Livepeer-Protocol",
  REQUEST_ID: "Livepeer-Request-Id",
  BACKOFF: "Livepeer-Backoff",
  WORK_UNITS: "Livepeer-Work-Units",
  WORK_UNIT: "Livepeer-Work-Unit",
  JOB_ID: "Livepeer-Job-Id",
  SETTLEMENT: "Livepeer-Settlement",
  ERROR: "Livepeer-Error",
  SELECTOR_EXTRA: "Livepeer-Selector-Extra",
  SELECTOR_CONSTRAINTS: "Livepeer-Selector-Constraints",
  SELECTOR_MAX_PRICE_WEI: "Livepeer-Selector-Max-Price-Wei",
} as const;

export const PAID_JOB_PROTOCOL = "paid-job/v1";
