import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createPool, createDb, runMigrations } from '../src/db.js';
import * as repo from '../src/repo/usageReservations.js';
import { commitment, routeSnapshot } from './wholesale-fixtures.js';

const testUrl = process.env['TEST_DATABASE_URL'];
test('Postgres preserves historical rows, rejects domain drift, and recovers NO_RECORD accounting', {skip:!testUrl}, async()=>{
  const pool=createPool(testUrl!); const db=createDb(pool);
  try {
    await runMigrations(db, {migrationsDir:fileURLToPath(new URL('../../migrations/',import.meta.url))});
    const id=randomUUID(),key=randomUUID(),work=randomUUID();
    await db.execute(sql`INSERT INTO waitlist(id,name,email,status) VALUES(${id},'fixture',${id+'@example.invalid'},'approved')`);
    await db.execute(sql`INSERT INTO api_keys(id,waitlist_id,key_prefix,key_hash) VALUES(${key},${id},'test',${id})`);
    await db.execute(sql`INSERT INTO usage_reservations(work_id,api_key_id,capability,model) VALUES(${work},${key},'c','o')`);
    const before=await db.execute(sql`SELECT accounting_mode,route_snapshot FROM usage_reservations WHERE work_id=${work}`);
    assert.deepEqual(before.rows[0],{accounting_mode:null,route_snapshot:null});
    const request={...commitment,idempotencyKey:work,capability:'c',offering:'o',transport:'unary' as const,estimatedUnits:2};
    await repo.recordOpenIntent(db,work,request,0);
    assert.deepEqual((await repo.pendingOpenIntents(db,10))[0]!.request,request);
    const snapshot=routeSnapshot();
    const job={jobId:'j',requestId:'r',workId:'auth',brokerUrl:snapshot.broker_url,protocol:'paid-job/v1' as const,transport:'unary' as const,workUnit:'tokens',spendAuthorization:'YQ==',accountingMode:'wholesale_account' as const,routeSnapshot:snapshot,expectedValueWei:'1',fundedValueWei:'1',settleEndpoint:'/v1/jobs/j/settle',openedAt:new Date().toISOString()};
    await repo.recoverOpenIdentity(db,work,request,job);
    assert.equal((await repo.pendingOpenIntents(db,10)).length,0);
    await assert.rejects(repo.recoverOpenIdentity(db,work,request,{...job,workId:'other'}),/identity drift/);
    const row=(await repo.claimPendingSettlementLookups(db,10))[0]!;
    await repo.deferSettlementLookup(db,row.id,'no_record',new Date(0),'not yet admitted');
    assert.equal((await repo.claimPendingSettlementLookups(db,10))[0]!.id,row.id);
    const evidence={requestId:'r',brokerJobId:'broker',paymentWorkId:'auth',workUnit:'tokens',encoded:'signed-wire',envelope:{payload:{authorization_id:'auth',settlement_domain_id:snapshot.settlement_domain_id}},actualUnits:'2',debitedUnits:'2',billedValueWei:'1',outcome:'EXACT'};
    await repo.recordSettlementEvidence(db,row.id,evidence);
    await repo.recordLocStatus(db,row.id,{jobId:'j',requestId:'r',workId:'auth',state:'closed',accountingOutcome:'conservative_full_charge',actualUnits:null,billedValueWei:'100',closedAt:new Date().toISOString()});
    const recorded=await db.execute(sql`SELECT state,broker_actual_units,loc_settled_units,loc_accounting_outcome,loc_billed_value_wei,spend_authorization,units_per_price FROM usage_reservations WHERE work_id=${work}`);
    assert.equal(recorded.rows[0]!.state,'open');
    assert.equal(recorded.rows[0]!.broker_actual_units,'2');
    assert.equal(recorded.rows[0]!.loc_settled_units,null);
    assert.equal(recorded.rows[0]!.loc_accounting_outcome,'conservative_full_charge');
    assert.equal(recorded.rows[0]!.loc_billed_value_wei,'100');
    assert.equal(recorded.rows[0]!.spend_authorization,'YQ==');
    assert.equal(recorded.rows[0]!.units_per_price,'1000');
    await assert.rejects(repo.recordSettlementEvidence(db,row.id,{...evidence,envelope:{payload:{authorization_id:'auth',settlement_domain_id:'0x'+'ff'.repeat(32)}}}),/domain drift/);
  } finally {await pool.end();}
});

test('Postgres refresh preserves partial omissions and stale timestamps, then removes authoritative absences', { skip: !testUrl }, async () => {
  const { upsertModelsFromSnapshot } = await import('../src/registry/refresh.js');
  const { flattenCapabilities } = await import('../src/registry/catalog.js');
  const { catalogMetadata } = await import('./catalog-fixtures.js');
  const pool = createPool(testUrl!);
  const db = createDb(pool);
  try {
    await runMigrations(db, { migrationsDir: fileURLToPath(new URL('../../migrations/', import.meta.url)) });
    const candidates = flattenCapabilities([{ name: 'test:catalog', workUnit: 'tokens', offerings: ['a', 'b'].map(id => ({
      id, pricePerWorkUnitWei: '1', unitsPerPrice: 1, workUnit: 'tokens', protocol: 'paid-job/v1', transports: ['unary' as const], extra: {},
    })) }]);
    const catalog = catalogMetadata();
    const rows = async () => (await db.execute(sql`SELECT model_id, active, snapshot_at FROM models WHERE capability='test:catalog' ORDER BY model_id`)).rows;
    await upsertModelsFromSnapshot(db, { candidates, catalog });
    await upsertModelsFromSnapshot(db, { candidates: candidates.slice(0, 1), catalog: { ...catalog, completeness: 'PARTIAL' } });
    assert.deepEqual((await rows()).map(r => r.active), [true, true]);
    const before = await rows();
    for (const metadata of [
      { ...catalog, stale: true },
      { ...catalog, completeness: 'UNINITIALIZED' as const },
      { ...catalog, coverage_valid_until: '2000-01-01T00:00:00Z' },
    ]) {
      assert.equal(await upsertModelsFromSnapshot(db, { candidates: [], catalog: metadata }), 0);
      assert.deepEqual(await rows(), before);
    }
    await upsertModelsFromSnapshot(db, { candidates: [], catalog: null });
    assert.deepEqual(await rows(), before);
    assert.equal(new Date(before[0]!.snapshot_at as string).getTime(), Date.parse(catalog.snapshot_at!));
    await upsertModelsFromSnapshot(db, { candidates: candidates.slice(0, 1), catalog });
    assert.deepEqual((await rows()).map(r => r.active), [true, false]);
    await upsertModelsFromSnapshot(db, { candidates: [], catalog });
    assert.deepEqual((await rows()).map(r => r.active), [false, false]);
  } finally { await pool.end(); }
});

test('Postgres closes zero-billed rejected admissions without inventing broker evidence', { skip: !testUrl }, async () => {
  const pool = createPool(testUrl!);
  const db = createDb(pool);
  try {
    await runMigrations(db, { migrationsDir: fileURLToPath(new URL('../../migrations/', import.meta.url)) });
    const id = randomUUID(), key = randomUUID(), work = randomUUID();
    await db.execute(sql`INSERT INTO waitlist(id,name,email,status) VALUES(${id},'fixture',${id+'@example.invalid'},'approved')`);
    await db.execute(sql`INSERT INTO api_keys(id,waitlist_id,key_prefix,key_hash) VALUES(${key},${id},'test',${id})`);
    const inserted = await db.execute(sql`INSERT INTO usage_reservations(work_id,api_key_id,capability,model,loc_job_id,loc_request_id,payment_work_id) VALUES(${work},${key},'c','o','rejected-job','rejected-request','rejected-auth') RETURNING id`);
    const reservationId = inserted.rows[0]!.id as string;
    await repo.recordSettlementLookupTerminal(db, reservationId, 'not_admitted', 'signed audit only', 'signed-non-admission');
    await repo.recordLocStatus(db, reservationId, { jobId: 'rejected-job', requestId: 'rejected-request', workId: 'rejected-auth', state: 'closed', accountingOutcome: 'broker_settled', actualUnits: '0', billedValueWei: '0', closedAt: '2026-09-24T12:00:00Z' });
    const result = await db.execute(sql`SELECT settle_state,loc_settled_units,loc_billed_value_wei,broker_actual_units,settlement_envelope,terminal_evidence_encoded FROM usage_reservations WHERE id=${reservationId}`);
    assert.deepEqual(result.rows[0], { settle_state: 'settled', loc_settled_units: '0', loc_billed_value_wei: '0', broker_actual_units: null, settlement_envelope: null, terminal_evidence_encoded: 'signed-non-admission' });
    assert.ok(!(await repo.pendingLocStatuses(db, 100)).some(row => row.id === reservationId));
  } finally { await pool.end(); }
});
