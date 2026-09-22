import type { RouteSnapshot } from '../src/loc/client.js';
export const commitment = { workloadRequestDigest: 'ab'.repeat(32), callerPublicKey: '02' + 'cd'.repeat(32) };
export function routeSnapshot(brokerUrl = 'https://broker.example', capability = 'c', offering = 'o'): RouteSnapshot {
  return {
    schema_version: 'route-snapshot/v1', broker_url: brokerUrl,
    eth_address: '0x' + '11'.repeat(20), capability, offering, protocol: 'paid-job/v1',
    work_unit: 'tokens', price_per_work_unit_wei: '100', units_per_price: 1000,
    quote_id: 'quote-1', quote_version: 1, constraint_fingerprint: 'aa'.repeat(32),
    route_fingerprint: 'bb'.repeat(32), settlement_domain_id: '0x' + 'cc'.repeat(32),
    settlement_keys: [{ public_key: '02' + 'dd'.repeat(32) }],
  };
}
