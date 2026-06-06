#!/usr/bin/env bash
# End-to-end smoke test for `make smoke`.
#
# Assumes `make dev` already brought up the compose stack (gateway + db)
# with LOC_BASE_URL/LOC_API_KEY pointing at a live LOC clearinghouse.
# Exercises the public + portal + admin + /v1/* surfaces.

set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:4000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-${SMOKE_ADMIN_TOKEN:-smoke-admin-token}}"
EMAIL="smoke+$(date +%s)@example.com"
NAME="Smoke Tester"

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

require_status() {
  local expected="$1" actual="$2" what="$3"
  if [[ "$expected" != "$actual" ]]; then
    fail "$what — expected $expected, got $actual"
  fi
  pass "$what ($actual)"
}

# ── 0. health ─────────────────────────────────────────────────────
section "health"
status=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY/health")
require_status 200 "$status" "GET /health"

# ── 1. /v1/models — non-empty registry-backed catalog ────────────
section "catalog"
body=$(curl -fsS "$GATEWAY/v1/models")
echo "$body" | grep -q '"object":"list"' || fail "GET /v1/models response shape"
model=$(docker compose exec -T db \
  psql -U "${POSTGRES_USER:-openai_service}" -d "${POSTGRES_DB:-openai_service}" \
  -tAc "SELECT model_id FROM models WHERE active = true AND capability = 'openai:embeddings' ORDER BY snapshot_at DESC LIMIT 1;" | tr -d '[:space:]')
[[ -n "$model" ]] || fail "no active embeddings model in models cache"
pass "GET /v1/models returns OpenAI catalog shape"
pass "selected embeddings-capable model ($model)"

# ── 2. signup ─────────────────────────────────────────────────────
section "signup → verify → approve"
status=$(curl -s -o /tmp/smoke-signup.json -w "%{http_code}" -X POST "$GATEWAY/api/waitlist" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\",\"email\":\"$EMAIL\"}")
require_status 200 "$status" "POST /api/waitlist"

# ── 3. flip email_verified_at via the DB (in real life: click the email
#       link). We do it directly through psql in the db container.
docker compose exec -T db \
  psql -U "${POSTGRES_USER:-openai_service}" -d "${POSTGRES_DB:-openai_service}" \
  -c "UPDATE waitlist SET email_verified_at=now() WHERE email='$EMAIL';" >/dev/null \
  || fail "db psql exec failed (compose db container not up?)"
pass "marked email_verified_at via db"

# ── 4. admin approve ─────────────────────────────────────────────
wid=$(docker compose exec -T db \
  psql -U "${POSTGRES_USER:-openai_service}" -d "${POSTGRES_DB:-openai_service}" \
  -tAc "SELECT id FROM waitlist WHERE email='$EMAIL';" | tr -d '[:space:]')
[[ -n "$wid" ]] || fail "waitlist row id"
pass "waitlist row id ($wid)"

status=$(curl -s -o /tmp/smoke-approve.json -w "%{http_code}" \
  -X POST -H "X-Admin-Token: $ADMIN_TOKEN" "$GATEWAY/admin/waitlist/$wid/approve")
require_status 200 "$status" "POST /admin/waitlist/:id/approve"

# Pull the plaintext key out of the gateway logs (email is disabled in
# default compose; the key was logged with "would have sent").
key=$(docker compose logs --tail=100 gateway 2>/dev/null | grep -oE 'sk-[A-Za-z0-9_-]{40,}' | head -1 || true)
[[ -n "$key" ]] || fail "no plaintext API key found in gateway logs"
pass "extracted plaintext key (${key:0:11}…)"

# ── 5. portal login + account ────────────────────────────────────
section "portal cookie flow"
jar=$(mktemp)
trap 'rm -f $jar' EXIT
status=$(curl -s -c "$jar" -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY/portal/login" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$key\"}")
require_status 200 "$status" "POST /portal/login"

acc=$(curl -fsS -b "$jar" "$GATEWAY/portal/account")
echo "$acc" | grep -q "$EMAIL" || fail "/portal/account email mismatch"
pass "GET /portal/account returns session user"

# ── 6. /v1/* bearer auth ─────────────────────────────────────────
section "/v1/* bearer auth"
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GATEWAY/v1/embeddings" \
  -H "Content-Type: application/json" -d '{"model":"x","input":"hi"}')
require_status 401 "$status" "POST /v1/embeddings without auth → 401"

status=$(curl -s -o /tmp/smoke-emb.json -w "%{http_code}" -X POST "$GATEWAY/v1/embeddings" \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" -d "{\"model\":\"$model\",\"input\":\"hi\"}")
require_status 200 "$status" "POST /v1/embeddings with valid key"

# ── 7. usage_reservations recorded the request ──────────────────
recs=$(docker compose exec -T db \
  psql -U "${POSTGRES_USER:-openai_service}" -d "${POSTGRES_DB:-openai_service}" \
  -tAc "SELECT count(*) FROM usage_reservations WHERE state='committed';" | tr -d '[:space:]')
[[ "$recs" -ge 1 ]] || fail "expected at least 1 committed reservation, got $recs"
pass "usage_reservations recorded the request ($recs committed total)"

# ── 8. metrics ──────────────────────────────────────────────────
section "/metrics"
status=$(curl -s -o /tmp/smoke-metrics.txt -w "%{http_code}" "$GATEWAY/metrics")
require_status 200 "$status" "GET /metrics"
grep -q "openai_service_proxy_reservations_total" /tmp/smoke-metrics.txt \
  || fail "/metrics missing proxy reservation counter"
pass "/metrics exposes openai_service_proxy_reservations_total"

# ── done ────────────────────────────────────────────────────────
section "smoke passed"
