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
