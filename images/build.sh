#!/bin/bash
#####################################
# Ionnet GSS image builder (local)  #
#####################################
# Builds the game images with local tags only (nothing is pushed):
#   ghcr.io/ionnet-dev/ionnet-gss-base:dev and :latest
#   ghcr.io/ionnet-dev/ionnet-gss-minecraft-server:java8 / java17 / java21 / java25
# Usage: images/build.sh [base|minecraft|all]   (default all; run from anywhere)
set -euo pipefail

REGISTRY="${IMAGE_REGISTRY:-ghcr.io/ionnet-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAVA_VERSIONS=(8 17 21 25)

# Build ionnet-gss-base from the repo root (it compiles gss-init from agent/).
build_base() {
  echo "Building ${REGISTRY}/ionnet-gss-base..."
  docker build -f "$ROOT/images/base/Dockerfile" -t "${REGISTRY}/ionnet-gss-base:dev" -t "${REGISTRY}/ionnet-gss-base:latest" "$ROOT"
}

# Build one ionnet-gss-minecraft-server tag per Java line on top of the local base.
build_minecraft() {
  local JAVA
  for JAVA in "${JAVA_VERSIONS[@]}"; do
    echo "Building ${REGISTRY}/ionnet-gss-minecraft-server:java${JAVA}..."
    docker build --build-arg "BASE=${REGISTRY}/ionnet-gss-base:latest" --build-arg "JAVA=${JAVA}" \
      -t "${REGISTRY}/ionnet-gss-minecraft-server:java${JAVA}" "$ROOT/images/minecraft-server"
  done
}

case "${1:-all}" in
  base) build_base ;;
  minecraft) build_minecraft ;;
  all) build_base; build_minecraft ;;
  *) echo "Command not found: $1. Use base, minecraft or all." >&2; exit 2 ;;
esac
echo "Done!"
