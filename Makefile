# OpenAI Service — root Makefile
#
# Root targets for the gateway-side stack and web UIs.

.DEFAULT_GOAL := help

.PHONY: help install build lint test dev down logs clean smoke web site-ui portal-ui admin-ui

help:
	@echo "OpenAI Service — root targets"
	@echo ""
	@echo "  make install     pnpm install (workspace)"
	@echo "  make build       build all workspace packages"
	@echo "  make lint        run tsc / linters across the workspace"
	@echo "  make test        run all tests"
	@echo "  make dev         bring up gateway + postgres via docker compose"
	@echo "  make down        tear down dev compose stack"
	@echo "  make logs        tail dev compose logs"
	@echo "  make smoke       end-to-end smoke test against the dev stack"
	@echo "  make web         start site + portal + admin dev servers"
	@echo "  make site-ui     start the site dev server (:3000)"
	@echo "  make portal-ui   start the portal dev server (:3001)"
	@echo "  make admin-ui    start the admin dev server (:3002)"
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
	docker compose --profile livepeer up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

smoke:
	./scripts/smoke.sh

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
