# proto

gRPC service definitions used by the gateway to talk to the Livepeer
daemons.

## Layout

```
proto/
└── livepeer/
    ├── payments/v1/
    │   ├── payer_daemon.proto       # PayerDaemon service (UDS, talks to payment-daemon)
    │   └── types.proto              # shared payment types
    └── registry/v1/
        ├── resolver.proto           # Resolver service (UDS, talks to service-registry-daemon)
        └── types.proto              # shared registry types
```

`@grpc/proto-loader` resolves `google/protobuf/empty.proto` and
`google/protobuf/timestamp.proto` from its own well-known-types
descriptors. No additional proto files needed.

## How the gateway loads these

`gateway/src/payer/` and `gateway/src/registry/` load protos at boot
via `@grpc/proto-loader`, passing this directory as `includeDirs`:

```ts
protoLoader.loadSync(
  ['livepeer/payments/v1/payer_daemon.proto', 'livepeer/payments/v1/types.proto'],
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    includeDirs: [PROTO_ROOT] },
);
```

`PROTO_ROOT` is set from `config.ts` (env-overridable via
`LIVEPEER_PROTO_ROOT`).

## Provenance

| Proto | Origin |
|---|---|
| `livepeer/payments/v1/*` | `livepeer-network-protocol/proto/` in the source `livepeer-network-modules` repo (matches what the gateway code expects). |
| `livepeer/registry/v1/*` | `proto-contracts/` in the source `livepeer-network-modules` repo. |

These are vendored copies; the daemon binaries (`payment-daemon`,
`service-registry-daemon`) are pulled as Docker images at runtime and
generated their own server-side stubs from these same `.proto` files
upstream. As long as the wire layout matches, vendored stubs stay
compatible across daemon versions.

## Updating

To re-sync from upstream:

```bash
# Payments
cp /path/to/livepeer-network-modules/livepeer-network-protocol/proto/livepeer/payments/v1/*.proto \
   proto/livepeer/payments/v1/

# Registry
cp /path/to/livepeer-network-modules/proto-contracts/livepeer/registry/v1/*.proto \
   proto/livepeer/registry/v1/
```

Then run the gateway test suite (Phase 4+) to confirm wire compatibility.
