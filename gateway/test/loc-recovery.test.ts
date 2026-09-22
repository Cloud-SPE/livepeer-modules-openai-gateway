import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryOnce, type RecoveryStore } from '../src/loc/recovery.js';
import { LocApiError, type LocClient, type JobStatus, type OpenJobResponse } from '../src/loc/client.js';
import { commitment, routeSnapshot } from './wholesale-fixtures.js';

const request = { ...commitment, idempotencyKey:'original-key', capability:'c', offering:'o', transport:'unary' as const, estimatedUnits:2 };
const job: OpenJobResponse = { jobId:'j', requestId:'r', workId:'a', brokerUrl:'https://broker.example', protocol:'paid-job/v1', transport:'unary', workUnit:'tokens', spendAuthorization:'YQ==', accountingMode:'wholesale_account', routeSnapshot:routeSnapshot(), expectedValueWei:'1', fundedValueWei:'1', settleEndpoint:'/v1/jobs/j/settle', openedAt:'2026-09-22T00:00:00Z' };
const status: JobStatus = {jobId:'j',requestId:'r',workId:'a',state:'closed',accountingOutcome:'broker_settled',actualUnits:'2',billedValueWei:'1',closedAt:'2026-09-22T00:00:00Z'};
function harness() {
  const events: unknown[]=[];
  const store: RecoveryStore = {
    opens:async()=>[{id:'local',workId:'local-work',request}],
    recover:async (...args)=>{events.push(['recover',...args]);},
    deferOpen:async (...args)=>{events.push(['defer-open',...args]);},
    statuses:async()=>[{id:'local',jobId:'j',requestId:'r',workId:'a'}],
    record:async (...args)=>{events.push(['status',...args]);},
    deferStatus:async (...args)=>{events.push(['defer-status',...args]);},
  };
  const loc = { openJob:async (req:unknown)=>{assert.deepEqual(req,request);return job;},getJob:async()=>status } as unknown as LocClient;
  return {events,store,loc};
}
test('restart recovers the same public open intent and LOC status without workload redispatch',async()=>{
  const h=harness(); await runRecoveryOnce(h.store,h.loc);
  assert.deepEqual(h.events,[['recover','local-work',request,job],['status','local',status]]);
});
test('funding uncertainty retries, definitive refusal stops opens, and status identity drift fails closed',async()=>{
  for (const [code,http,refused] of [['WHOLESALE_FUNDING_UNVERIFIED',503,false],['AUTHORIZATION_REFUSED',422,true],['ENGAGEMENT_CLOSED',409,true],['IDEMPOTENCY_IN_PROGRESS',409,false]] as const) {
    const h=harness(); h.loc.openJob=async()=>{throw new LocApiError({status:http,code,message:code});};
    h.loc.getJob=async()=>({...status,workId:'wrong'});
    await runRecoveryOnce(h.store,h.loc);
    assert.deepEqual(h.events,[['defer-open','local',refused],['defer-status','local','LOC status identity drift']]);
  }
});
test('non-admission audit and conservative charge remain distinct LOC observations',async()=>{
  for (const outcome of ['non_admission_audit','conservative_full_charge','unresolved'] as const) {
    const h=harness(); h.store.opens=async()=>[];
    const observed={...status,accountingOutcome:outcome,state:outcome==='conservative_full_charge'?'closed':'open'};
    h.loc.getJob=async()=>observed;
    await runRecoveryOnce(h.store,h.loc);
    assert.deepEqual(h.events,[['status','local',observed]]);
  }
});
