# PRODUCT_SENSE

Product principles that guide tradeoffs in this repo. When code, design,
or scope decisions are ambiguous, fall back to these.

## What we are

A **drop-in OpenAI replacement** for developers who already have OpenAI
SDK code. Change `base_url`, get the same shapes back, but the inference
runs on the Livepeer network.

## What we are not

- A general inference platform. We expose the OpenAI surface, not a custom
  one.
- A model hub. We don't host models; we route to whoever the on-chain
  registry advertises.
- A billing product. Beta is free; pricing comes later as a separate
  concern.

## Principles

1. **Compatibility is the feature.** If an OpenAI SDK call doesn't work
   verbatim against our `/v1/*`, that's a bug, not a feature gap.
2. **No surprise behavior.** A request that succeeds against OpenAI and
   fails against us should fail with a clear, actionable error — not a
   500.
3. **Zero per-request friction for users.** No rate-limit headers, no
   quota messages, no captchas. Friction goes at the *signup* layer
   (waitlist + admin approval), not the request layer.
4. **Free during beta means truly free.** No "free tier with limits" — no
   limits at all. Limits are a billing concern; billing isn't here yet.
5. **Models reflect reality.** `/v1/models` shows what the on-chain
   registry advertises *right now*, not a curated catalog. If a model
   appears on-chain, it appears in the API. If it disappears, the API
   reflects that within one refresh cycle.
6. **The portal is a courtesy, not a product.** The portal SPA exists so
   users can manage their API key and see usage. Anything that doesn't
   fit "managing my access" belongs out of the portal.
7. **Admin is a tool, not a product.** Admin exists so we (the operators)
   can keep the beta running. It's not for end-users and doesn't ship
   polish features.
8. **The marketing site is generic.** It says "OpenAI Service" and signs
   you up. Anyone deploying this repo can rebrand it without touching
   gateway code.

## When in doubt

- **Choose compatibility over cleverness.** If we're tempted to "improve"
  on OpenAI's API shape, don't.
- **Choose simplicity over completeness.** Ship the path that works for
  90% of users; document the 10% as known limitations.
- **Choose deletion over feature flags.** If something doesn't fit v1,
  remove it cleanly. We can add it back when we get to v2.
