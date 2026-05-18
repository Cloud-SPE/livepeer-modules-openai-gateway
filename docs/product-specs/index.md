# Product specs

User-facing surface specifications. Each spec describes what a user
should be able to do, in product language, not implementation
language.

## Index

| Spec | Audience | Summary |
|---|---|---|
| [`waitlist-signup.md`](./waitlist-signup.md) | Public visitor | Public landing → email verify → admin approval → API key by email. |
| [`portal-account.md`](./portal-account.md) | Approved user | Sign-in with API key, see account, manage keys, view usage. |
| [`admin-waitlist.md`](./admin-waitlist.md) | Operator | Admin queue, approval rules, registry debug surface. |
| [`openai-surface.md`](./openai-surface.md) | SDK developer | The `/v1/*` API contract: endpoints, auth, rate limit, error shapes. |

## Convention

Each spec answers, in this order:

1. **Who** is the user?
2. **What** can they do?
3. **Where** in the product (URL, SPA, route)?
4. **Why** does this exist (the product principle being satisfied)?
5. **Acceptance criteria** in user-visible language.
6. **Edge cases.**
7. **What this spec does NOT promise** (v1).
8. **Implementation reference** — pointer to code paths.

Implementation details go in `docs/design-docs/`, not here.
