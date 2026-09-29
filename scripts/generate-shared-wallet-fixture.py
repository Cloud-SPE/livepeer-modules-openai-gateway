"""Generate offline gateway vectors using an explicit LOC checkout and its venv.

Usage: <loc>/.venv/bin/python scripts/generate-shared-wallet-fixture.py <loc>
No network, wallets, or database. Keys below are public test constants.
"""
import base64
from dataclasses import replace
from datetime import datetime, UTC
import hashlib
import json
from pathlib import Path
import subprocess
import sys

loc = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(loc), str(loc / 'src')]
from livepeer_open_clearinghouse import _gen  # registers vendored protobufs
from livepeer.payments.v1 import types_pb2 as pb
from eth_hash.auto import keccak
from eth_keys.datatypes import PrivateKey
from tests.fixtures.signed_settlement import (
    signed_job_settlement, signed_non_admission, delegated_key,
)
from livepeer_open_clearinghouse.providers.settlement_verification import (
    JobSettlementExpectation, NonAdmissionExpectation, SettlementVerificationError,
    verify_job_settlement, verify_non_admission,
)

payer = PrivateKey(bytes([1]) * 32)
caller = PrivateKey(bytes([2]) * 32)
caller_public = caller.public_key.to_compressed_bytes()
body = '{"model":"fixture-model","messages":[{"role":"user","content":"fixture"}]}'
account = 'loc-test-a'
domain = '0x' + 'aa' * 32
payload = pb.SpendAuthorizationPayload(
    domain='livepeer-spend-authorization/v3', wholesale_account_id=account,
    payer=payer.public_key.to_canonical_address(), payee=bytes([0x11]) * 20,
    authorization_id='work-1', request_id='request-1', protocol='paid-job/v1',
    capability='openai:chat-completions', offering='fixture-model',
    max_debit_wei=pb.BigUInt(value=bytes([100])), max_total_units=100,
    not_before='2026-08-20T11:59:00Z', expires_at='2026-08-20T12:05:00Z',
    request_digest=hashlib.sha256(body.encode()).digest(), caller_public_key=caller_public,
    broker_uri='https://broker.example', chain_id=42161, denomination='wei',
    settlement_domain_id=domain,
)
payload.accepted_price.CopyFrom(pb.AcceptedPrice(
    price_per_unit_wei=pb.BigUInt(value=bytes([1])), units_per_price=1,
    work_unit_name='token', capability=payload.capability, offering=payload.offering,
    quote_ref=pb.QuoteRef(quote_id='q-1', quote_version=1,
        constraint_fingerprint=bytes(32), route_fingerprint=bytes([0x11]) * 32),
))

def authority(account_id):
    p = pb.SpendAuthorizationPayload()
    p.CopyFrom(payload)
    p.wholesale_account_id = account_id
    raw = p.SerializeToString(deterministic=True)
    sig = bytearray(payer.sign_msg_hash(keccak(b'\x19Ethereum Signed Message:\n32' + keccak(raw))).to_bytes())
    sig[64] += 27
    wire = pb.SpendAuthorization(payload=p, signature=bytes(sig)).SerializeToString(deterministic=True)
    return base64.b64encode(wire).decode()

settlement = signed_job_settlement(job_id='broker-job-1', work_id='work-1',
    request_id='request-1', actual_units=5, amount_wei=1, per_units=1,
    authorization_id='work-1', authorized_value_wei=100, reserved_value_wei=100,
    released_value_wei=95, outcome='EXACT', wholesale_account_id=account)
expected = JobSettlementExpectation(wholesale_account_id=account,
    settlement_domain_id=domain, request_id='request-1', job_id='broker-job-1',
    work_id='work-1', work_unit='token', actual_units=5, max_total_units=100,
    funded_value_wei=100, amount_wei=1, per_units=1, quote_id='q-1', quote_version=1,
    constraint_fingerprint=bytes(32), route_fingerprint=bytes([0x11]) * 32,
    authorization_id='work-1', authorized_value_wei=100)
audit = signed_non_admission(wholesale_account_id=account)
audit_expected = NonAdmissionExpectation(wholesale_account_id=account,
    settlement_domain_id=domain, protocol='paid-job/v1', request_id='request-1',
    work_id='work-1', sender=bytes([0xaa]) * 20, recipient=bytes([0x11]) * 20,
    quote_id='q-1', quote_version=1, constraint_fingerprint=bytes(32),
    route_fingerprint=bytes([0x11]) * 32, broker_eth_address='0x' + '11' * 20,
    job_issued_at=datetime(2026, 8, 20, 11, 59, tzinfo=UTC))
rejections = []
for verify, evidence, expectation in [
    (verify_job_settlement, settlement, expected),
    (verify_non_admission, audit, audit_expected),
]:
    verify(evidence, settlement_keys=[delegated_key()], expected=expectation)
    try:
        verify(evidence, settlement_keys=[delegated_key()],
            expected=replace(expectation, wholesale_account_id='loc-test-b'))
    except SettlementVerificationError as exc:
        assert exc.code == 'wholesale_account_mismatch', exc.code
        rejections.append(exc.code)
    else:
        raise AssertionError('LOC accepted cross-account evidence')

out = dict(
    loc_revision=subprocess.check_output(['git', '-C', str(loc), 'rev-parse', 'HEAD'], text=True).strip(),
    source_sha256={name: hashlib.sha256((loc / name).read_bytes()).hexdigest() for name in [
        'tests/fixtures/signed_settlement.py',
        'src/livepeer_open_clearinghouse/providers/settlement_verification.py',
        'src/livepeer_open_clearinghouse/_gen/livepeer/payments/v1/types_pb2.py',
    ]},
    authorization_domain=payload.domain, account_id=account,
    caller_private_key=bytes([2]).hex() * 32, caller_public_key=caller_public.hex(),
    payer_public_key=payer.public_key.to_compressed_bytes().hex(),
    body=body, request_digest=payload.request_digest.hex(),
    authorization=authority(account), other_account_authorization=authority('loc-test-b'),
    settlement=settlement, non_admission=audit, verified_rejections=rejections,
)
target = Path(__file__).resolve().parents[1] / 'gateway/test/fixtures/shared-wallet.json'
target.write_text(json.dumps(out, indent=2) + '\n')
print('Generated fixture; LOC verified settlement and non-admission and rejected both cross-account cases.')
