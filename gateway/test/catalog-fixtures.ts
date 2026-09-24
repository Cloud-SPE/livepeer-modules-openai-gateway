import type { LocCatalogMetadata } from '../src/loc/client.js';

export function catalogMetadata(overrides: Partial<LocCatalogMetadata> = {}): LocCatalogMetadata {
  return {
    completeness: 'COMPLETE', stale: false,
    coverage: { known_addresses: 2, verified_compatible_addresses: 2 },
    snapshot_at: '2026-09-24T12:00:00Z', evaluated_at: '2026-09-24T12:01:00Z',
    discovery_scope: 'registered', discovery_scope_authoritative: true,
    discovery_observed_at: '2026-09-24T12:00:00Z',
    discovery_valid_until: null, coverage_valid_until: null,
    ...overrides,
  };
}
