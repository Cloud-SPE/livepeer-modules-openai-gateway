# OpenAI Service — root Makefile
#
# Root targets for the gateway-side stack and web UIs.

.DEFAULT_GOAL := help

# ── Docker image publishing ─────────────────────────────────────────
# The checked-in build script is the single source of truth for local and CI
# image builds. These variables preserve the convenient Make interface.
# Authenticate first with `docker login docker.io -u <your-dockerhub-username>`.
IMAGE ?= tztcloud/openai-service-gateway
TAG   ?= dev

.PHONY: help install build lint test dev pilot down logs clean smoke live-conformance loc-smoke web site-ui portal-ui admin-ui \
        docker-build docker-publish release-check release-config

help:
	@echo "OpenAI Service — root targets"
	@echo ""
	@echo "  make install     pnpm install (workspace)"
	@echo "  make build       build all workspace packages"
	@echo "  make lint        run tsc / linters across the workspace"
	@echo "  make test        run all tests"
	@echo "  make dev         bring up the full local stack via docker compose"
	@echo "  make pilot       run the localhost paid-job pilot in the foreground"
	@echo "  make down        tear down dev compose stack"
	@echo "  make logs        tail dev compose logs"
	@echo "  make smoke       end-to-end smoke test against the dev stack"
	@echo "  make live-conformance"
	@echo "                    exercise unary, stream, multipart, and settlement"
	@echo "                    (requires OPENAI_API_KEY)"
	@echo "  make loc-smoke   execute and settle a signed paid-job/v1 exchange"
	@echo "                    (uses the private localhost OpenAI pilot credential)"
	@echo "  make web         start site + portal + admin dev servers"
	@echo "  make site-ui     start the site dev server (:3000)"
	@echo "  make portal-ui   start the portal dev server (:3001)"
	@echo "  make admin-ui    start the admin dev server (:3002)"
	@echo ""
	@echo "  make docker-build TAG=v2.0.0"
	@echo "                    build the gateway image as tztcloud/openai-service-gateway:<TAG>"
	@echo "  make docker-publish TAG=v2.0.0"
	@echo "                    build multi-arch + push to tztcloud/* on Docker Hub"
	@echo "                    (requires \`docker login docker.io\` first)"
	@echo "  make release-check TAG=v2.0.0"
	@echo "                    verify the local release image metadata and contents"
	@echo "  make release-config GATEWAY_IMAGE=repo@sha256:digest"
	@echo "                    render the digest-pinned production Compose config"
	@echo "  make clean       remove node_modules, dist, compose volumes"

install:
	pnpm install --frozen-lockfile

build:
	pnpm -r build

lint:
	pnpm -r lint

test:
	pnpm -r test

dev:
	docker compose up

pilot:
	@test -f ../livepeer-modules-open-clearinghouse/.dev/pilot/credentials/openai.json
	@LOC_BASE_URL=http://127.0.0.1:8088 \
	LOC_API_KEY=$$(jq -er '.api_key' ../livepeer-modules-open-clearinghouse/.dev/pilot/credentials/openai.json) \
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

smoke:
	./scripts/smoke.sh

live-conformance:
	@cd gateway && pnpm exec tsx ../scripts/live-conformance.ts

loc-smoke:
	@credential=../livepeer-modules-open-clearinghouse/.dev/pilot/credentials/openai.json; \
	if [ -z "$$LOC_API_KEY" ] && [ -f "$$credential" ]; then \
		export LOC_BASE_URL=http://127.0.0.1:8088; \
		export LOC_API_KEY=$$(jq -er '.api_key' "$$credential"); \
	fi; \
	cd gateway && pnpm exec tsx ../scripts/loc-smoke.ts

web:
	@trap 'kill 0' INT TERM EXIT; \
		( cd web/site && node dev-server.js ) & \
		( cd web/portal && node dev-server.js ) & \
		( cd web/admin && node dev-server.js ) & \
		wait

site-ui:
	cd web/site && node dev-server.js

portal-ui:
	cd web/portal && node dev-server.js

admin-ui:
	cd web/admin && node dev-server.js

clean:
	pnpm -r exec -- rm -rf node_modules dist dist-test
	docker compose down -v 2>/dev/null || true

# ── Docker image: build + publish ───────────────────────────────────
# docker-build: single-arch (host's arch) for quick local testing.
#   make docker-build TAG=v2.0.0
# docker-publish: multi-arch (linux/amd64 + linux/arm64), pushed.
#   make docker-publish TAG=v2.0.0
# Requires `docker login docker.io` first; refuses to push :dev.

docker-build:
	@REGISTRY=$$(printf '%s' '$(IMAGE)' | sed 's|/[^/]*$$||') \
	IMAGE_NAME=$$(printf '%s' '$(IMAGE)' | sed 's|.*/||') \
	TAG='$(TAG)' ./infra/scripts/build-images.sh

docker-publish:
	@REGISTRY=$$(printf '%s' '$(IMAGE)' | sed 's|/[^/]*$$||') \
	IMAGE_NAME=$$(printf '%s' '$(IMAGE)' | sed 's|.*/||') \
	TAG='$(TAG)' PUSH=1 ./infra/scripts/build-images.sh

release-check:
	@export RELEASE_IMAGE='$(IMAGE):$(TAG)'; \
	export RELEASE_VERSION=$$(printf '%s' '$(TAG)' | sed 's/^v//'); \
	export RELEASE_BUILD_VERSION=$$(VERSION_PREFIX='$(TAG)' FALLBACK_VERSION='$(TAG)' ./infra/build/git-version.sh); \
	export RELEASE_REVISION=$$(git rev-parse HEAD); \
	cd gateway && pnpm exec tsx ../scripts/verify-release-image.ts

release-config:
	@printf '%s' '$(GATEWAY_IMAGE)' | \
		rg -q '^.+@sha256:[0-9a-f]{64}$$' || { \
			echo "GATEWAY_IMAGE must be repository@sha256:<64 hex characters>"; exit 1; \
		}
	@GATEWAY_IMAGE='$(GATEWAY_IMAGE)' docker compose \
		-f docker-compose.yml -f docker-compose.release.yml config
