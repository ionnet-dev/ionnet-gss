#!/bin/bash
#####################################
# Ionnet GSS image builder (local)  #
#####################################
# Builds the images with local tags only (nothing is pushed). Published images come from CI instead:
# ionnet-gss-base from this repository (.github/workflows/base-image.yml), the game images from ionnet-gss-games
# (games/.github/workflows/images.yml). Local builds are for development and for testing an image change first.
#   base:  ${REGISTRY}/ionnet-gss-base:dev and :latest
#   games: every variant of games/<game>/image/image.yml as ${REGISTRY}/<name>:<tag>, on the local base
# Usage: images/build.sh [base|games|all] [game]   (default all; run from anywhere)
#        images/build.sh minecraft                  (the same as: games minecraft-java)
set -euo pipefail

REGISTRY="${IMAGE_REGISTRY:-ghcr.io/ionnet-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Build ionnet-gss-base from the repo root (it compiles gss-init from agent/).
build_base() {
  echo "Building ${REGISTRY}/ionnet-gss-base..."
  docker build -f "$ROOT/images/base/Dockerfile" -t "${REGISTRY}/ionnet-gss-base:dev" -t "${REGISTRY}/ionnet-gss-base:latest" "$ROOT"
}

# Print one line per image variant: folder, image name, tag and build args (KEY=value, space separated).
# Only the game named by $1, or every game with an image/image.yml.
list_variants() {
  local GAME="${1:-}"
  (cd "$ROOT" && deno eval --quiet '
    import { parse } from "@std/yaml";
    const only = Deno.args[0] ?? "";
    for (const entry of [...Deno.readDirSync("games")].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory || (only !== "" && entry.name !== only)) continue;
      let text;
      try {
        text = Deno.readTextFileSync(`games/${entry.name}/image/image.yml`);
      } catch {
        continue;
      }
      const image = parse(text);
      for (const variant of image.variants ?? []) {
        const args = Object.entries(variant.args ?? {}).map(([key, value]) => `${key}=${value}`).join(" ");
        console.log([entry.name, image.name, variant.tag, args].join("\t"));
      }
    }
  ' "$GAME")
}

# Build the game images (all, or the one game named by $1) on top of the local base.
build_games() {
  local GAME="${1:-}" FOLDER NAME TAG ARGS FOUND=0
  local -a BUILD_ARGS
  while IFS=$'\t' read -r FOLDER NAME TAG ARGS; do
    FOUND=1
    BUILD_ARGS=(--build-arg "BASE=${REGISTRY}/ionnet-gss-base:latest")
    for ARG in $ARGS; do
      BUILD_ARGS+=(--build-arg "$ARG")
    done
    echo "Building ${REGISTRY}/${NAME}:${TAG}..."
    docker build "${BUILD_ARGS[@]}" -t "${REGISTRY}/${NAME}:${TAG}" "$ROOT/games/${FOLDER}/image"
  done < <(list_variants "$GAME")
  if [[ "$FOUND" == "0" ]]; then
    echo "No game image found${GAME:+ for \"$GAME\"}. Games with an image have games/<game>/image/image.yml (is the games submodule checked out?)." >&2
    exit 1
  fi
}

case "${1:-all}" in
  base) build_base ;;
  games) build_games "${2:-}" ;;
  minecraft) build_games minecraft-java ;;
  all) build_base; build_games ;;
  *) echo "Command not found: $1. Use base, games [game], minecraft or all." >&2; exit 2 ;;
esac
echo "Done!"
