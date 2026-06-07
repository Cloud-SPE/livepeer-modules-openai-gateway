# OpenAI Service — root Makefile
#
# Root targets for the gateway-side stack and web UIs.

.DEFAULT_GOAL := help

# ── Docker image publishing ─────────────────────────────────────────
# Matches the CI publish target and sibling gateway repos: manual
# publish with multi-arch buildx, pushed to tztcloud/* on Docker Hub.
# Authenticate first with `docker login docker.io -u <your-dockerhub-username>`.
IMAGE ?= tztcloud/openai-service-gateway
TAG   ?= dev

.PHONY: help install build lint test dev down logs clean smoke loc-smoke web site-ui portal-ui admin-ui \
        docker-build docker-publish

help:
	@echo "OpenAI Service — root targets"
	@echo ""
	@echo "  make install     pnpm install (workspace)"
	@echo "  make build       build all workspace packages"
	@echo "  make lint        run tsc / linters across the workspace"
	@echo "  make test        run all tests"
	@echo "  make dev         bring up the full local stack via docker compose"
	@echo "  make down        tear down dev compose stack"
	@echo "  make logs        tail dev compose logs"
	@echo "  make smoke       end-to-end smoke test against the dev stack"
	@echo "  make loc-smoke   open + settle a 1-unit job against the live LOC"
	@echo "                    (requires LOC_API_KEY; LOC_BASE_URL optional)"
	@echo "  make web         start site + portal + admin dev servers"
	@echo "  make site-ui     start the site dev server (:3000)"
	@echo "  make portal-ui   start the portal dev server (:3001)"
	@echo "  make admin-ui    start the admin dev server (:3002)"
	@echo ""
	@echo "  make docker-build TAG=v1.3.0"
	@echo "                    build the gateway image as tztcloud/openai-service-gateway:<TAG>"
	@echo "  make docker-publish TAG=v1.3.0"
	@echo "                    build multi-arch + push to tztcloud/* on Docker Hub"
	@echo "                    (requires \`docker login docker.io\` first)"
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
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

smoke:
	./scripts/smoke.sh

loc-smoke:
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
#   make docker-build TAG=v1.3.0
# docker-publish: multi-arch (linux/amd64 + linux/arm64), pushed.
#   make docker-publish TAG=v1.3.0
# Requires `docker login docker.io` first; refuses to push :dev.

docker-build:
	docker build -t $(IMAGE):$(TAG) -f gateway/Dockerfile .
	@echo "built $(IMAGE):$(TAG)"

docker-publish:
	@if [ "$(TAG)" = "dev" ]; then \
		echo "refusing to publish :dev — set TAG (e.g. make docker-publish TAG=v1.3.0)"; \
		exit 1; \
	fi
	@# Default Docker driver doesn't support multi-arch — ensure a
	@# docker-container buildx builder exists for cross-arch builds.
	@docker buildx inspect multiarch >/dev/null 2>&1 || \
		docker buildx create --name multiarch --driver docker-container --bootstrap
	docker buildx build --builder multiarch \
		--platform linux/amd64,linux/arm64 \
		--push \
		-t $(IMAGE):$(TAG) \
		-t $(IMAGE):latest \
		-f gateway/Dockerfile \
		.
	@echo "published $(IMAGE):$(TAG) (and :latest)"
