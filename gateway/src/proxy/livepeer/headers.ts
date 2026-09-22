// Inlined Livepeer-* header constants. Mirrors
// @tztcloud/livepeer-gateway-middleware src/headers.ts; will be replaced
// with the package import once npm-workspace plumbing lands (tech-debt).

export const HEADER = {
  CAPABILITY: "Livepeer-Capability",
  OFFERING: "Livepeer-Offering",
  PAYMENT: "Livepeer-Payment",
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
