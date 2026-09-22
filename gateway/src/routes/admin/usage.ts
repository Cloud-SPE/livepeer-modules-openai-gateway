// Admin: aggregate usage across all API keys.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import * as usageRepo from '../../repo/usageReservations.js';
import { ErrorBody, Timestamp, UsageReservationRow } from '../../schema/api.js';

const ADMIN_SECURITY = [{ adminToken: [] as string[] }];

const UsageSummaryRow = z
  .object({
    apiKeyId: z.string().uuid(),
    email: z.string(),
    totalRequests: z.number(),
    committedTotal: z.number(),
    failedTotal: z.number(),
    lastUsedAt: Timestamp.nullable(),
  })
  .meta({ id: 'AdminUsageRow' });

const UsageResponse = z
  .object({
    data: z.array(UsageSummaryRow),
    recent: z.array(UsageReservationRow.extend({ email: z.string() })),
  })
  .meta({ id: 'AdminUsageResponse' });

export async function registerAdminUsageRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/usage',
    {
      schema: {
        tags: ['admin'],
        summary: 'Aggregate usage by API key',
        description: 'Joined to the owning user email. Top 200 keys by recency.',
        security: ADMIN_SECURITY,
        response: { 200: UsageResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const [summary, recent] = await Promise.all([
        usageRepo.summaryByApiKey(deps.db, 200),
        usageRepo.listRecentWithOwner(deps.db, 100),
      ]);
      return {
        data: summary.map((s) => ({
          apiKeyId: s.apiKeyId,
          email: s.email,
          totalRequests: s.totalRequests,
          committedTotal: s.committedTotal,
          failedTotal: s.failedTotal,
          lastUsedAt: s.lastUsedAt,
        })),
        recent: recent.map(({ reservation: r, email }) => ({
          email,
          id: r.id,
          workId: r.workId,
          apiKeyId: r.apiKeyId,
          capability: r.capability,
          model: r.model,
          brokerUrl: r.brokerUrl,
          ethAddress: r.ethAddress,
          selectedCapability: r.selectedCapability,
          selectedOffering: r.selectedOffering,
          selectedWorkUnit: r.selectedWorkUnit,
          unitsPerPrice: r.unitsPerPrice,
          pricePerWorkUnitWei: r.pricePerWorkUnitWei,
          quoteId: r.quoteId,
          quoteVersion: r.quoteVersion,
          constraintFingerprintHex: r.constraintFingerprintHex,
          routeFingerprintHex: r.routeFingerprintHex,
          estimatedWorkUnits: r.estimatedWorkUnits,
          locJobId: r.locJobId,
          locRequestId: r.locRequestId,
          paymentWorkId: r.paymentWorkId,
          brokerJobId: r.brokerJobId,
          jobProtocol: r.jobProtocol as 'paid-job/v1' | null,
          jobTransport: r.jobTransport as 'unary' | 'stream' | 'multipart' | null,
          settlementLookupState: r.settlementLookupState as
            | 'pending' | 'accounting_pending' | 'in_flight' | 'ready'
            | 'not_admitted' | 'no_record' | 'outcome_unknown' | 'evidence_expired' | 'failed' | null,
          settlementLookupAttempts: r.settlementLookupAttempts,
          settlementLookupLastError: r.settlementLookupLastError,
          brokerActualUnits: r.brokerActualUnits,
          brokerDebitedUnits: r.brokerDebitedUnits,
          brokerBilledValueWei: r.brokerBilledValueWei,
          brokerSettlementOutcome: r.brokerSettlementOutcome,
          gatewayObservedUnits: r.gatewayObservedUnits,
          gatewayObservationSource: r.gatewayObservationSource,
          locSettledUnits: r.locSettledUnits,
          locBilledValueWei: r.locBilledValueWei,
          locSettlementOutcome: r.locSettlementOutcome,
          locAccountingState: r.locAccountingState,
          locAccountingOutcome: r.locAccountingOutcome,
          settlementDomainId: r.settlementDomainId,
          settleState: r.settleState as 'pending' | 'settled' | 'failed' | null,
          settleAttempts: r.settleAttempts,
          terminalEvidenceType: r.terminalEvidenceType as
            | 'not_admitted' | 'outcome_unknown' | 'evidence_expired' | 'debit_failed' | null,
          state: r.state as 'open' | 'committed' | 'failed',
          committedWorkUnits: r.committedWorkUnits,
          latencyMs: r.latencyMs,
          statusCode: r.statusCode,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
        })),
      };
    },
  );
}
