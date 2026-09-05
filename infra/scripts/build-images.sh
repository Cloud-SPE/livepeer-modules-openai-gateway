#!/usr/bin/env bash
# Build the OpenAI Service image from one reproducible entrypoint.
#
# Usage:
#   ./infra/scripts/build-images.sh
#   ./infra/scripts/build-images.sh openai-service-gateway
#
# Env:
#   REGISTRY   default: tztcloud
#   TAG        default: read from infra/build/image-versions.env
#   VERSION    default: exact git tag, or TAG-sha[-dirty]
#   PUSH       set to 1 to publish linux/amd64 + linux/arm64
#   PLATFORMS  publish platforms; default: linux/amd64,linux/arm64
#
# Local builds target the host architecture and may include uncommitted work.
# Publishing refuses a dirty worktree, pushes only the requested tag, and
# prints the immutable multi-architecture manifest digest.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VERSION_ENV_FILE="${ROOT}/infra/build/image-versions.env"
if [[ -f "$VERSION_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$VERSION_ENV_FILE"
fi

REGISTRY="${REGISTRY:-tztcloud}"
IMAGE_NAME="${IMAGE_NAME:-openai-service-gateway}"
TAG="${TAG:-${IMAGE_TAG_DEFAULT:-v2.0.0}}"
PUSH="${PUSH:-0}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
VERSION="${VERSION:-$(VERSION_PREFIX="$TAG" FALLBACK_VERSION="$TAG" ./infra/build/git-version.sh)}"
APP_VERSION="$(node -p "require('./package.json').version")"
VCS_REF="$(git rev-parse HEAD)"

log()  { printf '\033[1;34m[build]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$PUSH" != "0" && "$PUSH" != "1" ]]; then
  fail "PUSH must be 0 or 1"
fi

if [[ "$TAG" == v* && "${TAG#v}" != "$APP_VERSION" ]]; then
  fail "release tag $TAG does not match package version $APP_VERSION"
fi

if [[ "$PUSH" == "1" && "$TAG" != "v${APP_VERSION}" ]]; then
  fail "publishing requires the exact release tag v${APP_VERSION}, got $TAG"
fi

if [[ "$PUSH" == "1" && -n "$(git status --porcelain)" ]]; then
  printf '\033[1;31m[fail]\033[0m refusing to push: working tree has uncommitted changes\n' >&2
  printf '       version would be %s, which no commit can reproduce.\n' "$VERSION" >&2
  git status --short >&2
  exit 1
fi

declare -a IMAGES=(
  "${IMAGE_NAME}|.|gateway/Dockerfile"
)

declare -a SELECTED=()
if [[ $# -eq 0 ]]; then
  SELECTED=("${IMAGES[@]}")
else
  for entry in "${IMAGES[@]}"; do
    name="${entry%%|*}"
    for filter in "$@"; do
      if [[ "$name" == *"$filter"* ]]; then
        SELECTED+=("$entry")
        break
      fi
    done
  done
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  fail "no images matched filter(s): $*"
fi

declare -a BUILD_ARGS=(
  "--build-arg=NODE_VERSION=${NODE_VERSION:-24}"
  "--build-arg=PNPM_VERSION=${PNPM_VERSION:-10.0.0}"
  "--build-arg=APP_VERSION=${APP_VERSION}"
  "--build-arg=BUILD_VERSION=${VERSION}"
  "--build-arg=VCS_REF=${VCS_REF}"
)

log "registry=$REGISTRY tag=$TAG version=$VERSION push=$PUSH building ${#SELECTED[@]} image(s)"

step=0
for entry in "${SELECTED[@]}"; do
  step=$((step + 1))
  IFS='|' read -r name context dockerfile <<<"$entry"
  full_tag="${REGISTRY}/${name}:${TAG}"
  log "[$step/${#SELECTED[@]}] $full_tag"

  if [[ "$PUSH" == "1" ]]; then
    command -v docker >/dev/null || fail "docker is required"
    docker buildx version >/dev/null 2>&1 || fail "docker buildx is required for publishing"
    docker buildx inspect multiarch >/dev/null 2>&1 || \
      docker buildx create --name multiarch --driver docker-container --bootstrap >/dev/null

    metadata_file="$(mktemp)"
    cleanup() { rm -f "$metadata_file"; }
    trap cleanup EXIT

    docker buildx build --builder multiarch \
      --platform "$PLATFORMS" \
      --push \
      --metadata-file "$metadata_file" \
      -t "$full_tag" \
      -f "$dockerfile" \
      "${BUILD_ARGS[@]}" \
      "$context" || fail "build or push failed for $full_tag"

    digest="$(jq -er '.["containerimage.digest"]' "$metadata_file")" || \
      fail "push completed but no manifest digest was reported"
    ok "[$step/${#SELECTED[@]}] pushed ${REGISTRY}/${name}@${digest}"
    cleanup
    trap - EXIT
  else
    docker build \
      -t "$full_tag" \
      -f "$dockerfile" \
      "${BUILD_ARGS[@]}" \
      "$context" || fail "build failed for $full_tag"
    ok "[$step/${#SELECTED[@]}] built $full_tag"
  fi
done

ok "all ${#SELECTED[@]} image(s) complete (registry=$REGISTRY tag=$TAG)"
