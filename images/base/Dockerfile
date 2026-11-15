# syntax=docker/dockerfile:1
# ionnet-gss-base: what every game container starts from (M2).
#   - gss-init as PID 1 (built here from agent/, static), at /usr/local/bin/gss-init
#   - curl, tar, unzip, xz, CA certs, and 32-bit runtime libs for steamcmd games (M3)
#   - user `gss` uid/gid 1000 (GAME_UID); the game and hooks run as it, gss-init itself runs as root
#   - /data (bind mount), /gss/spec (ro mount: spec.json + files/), /gss/run (rw mount: init.sock)
# Build context is the repo root: `deno task images:build` (images/build.sh). Nothing is pushed.

FROM golang:1.27-bookworm AS init
WORKDIR /src
COPY agent/ ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/ionnet-dev/ionnet-gss/agent/internal/version.Version=${VERSION}" -o /gss-init ./cmd/gss-init

FROM debian:trixie-slim
# TODO(builder): A — dpkg --add-architecture i386 + lib32gcc-s1 lib32stdc++6 for steamcmd; locales if games need them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 gss && useradd --uid 1000 --gid 1000 --home-dir /data --no-create-home --shell /bin/sh gss \
  && mkdir -p /data /gss/spec /gss/run
COPY --from=init /gss-init /usr/local/bin/gss-init
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/gss-init"]
