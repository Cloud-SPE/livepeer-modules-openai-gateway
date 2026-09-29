# Shared-wallet contract vectors

`shared-wallet.json` contains public test keys, deterministic protobuf v3 spend
authorizations for two accounts under one payer, and broker-signed JCS settlement
and non-admission envelopes. They are historical offline vectors, not live grants.

Regenerate explicitly using an installed LOC development environment:

```bash
/path/to/loc/.venv/bin/python scripts/generate-shared-wallet-fixture.py /path/to/loc
```

The generator uses LOC's vendored protobufs, signed fixture builders, and actual
settlement verifier. It verifies both evidence types and checks that changing the
expected account yields `wholesale_account_mismatch`. The authorization signature
uses deterministic protobuf, Keccak-256, and EIP-191, matching Modules spendauth.
The fixture records the LOC HEAD and exact SHA-256 hashes of the imported contract
sources because the upstream working tree may contain newer uncommitted changes.
The non-admission vector represents an alternative rejected exchange, not a
second outcome for the successful settlement.

Ordinary gateway tests consume this checked-in file without upstream imports or
network calls. Mock HTTP tests establish gateway preservation/error handling;
they do not stand in for real broker admission, current-time grant validation,
receiver funding, or pinned-image end-to-end conformance. The fixture caller key
is a known test constant; production caller keys remain random and ephemeral.
