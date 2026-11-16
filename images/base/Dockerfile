# syntax=docker/dockerfile:1
# ionnet-gss-base: what every game container starts from (M2).
#   - gss-init as PID 1 (built here from agent/, static), at /usr/local/bin/gss-init
#   - curl, tar, unzip, xz, jq, CA certs, procps, and 32-bit runtime libs for steamcmd games (M3, amd64 only)
#   - nftables: the agent also runs this image as its nft helper (host network, NET_ADMIN only) to apply the egress
#     filtering table; game containers never get NET_ADMIN, so `nft` is inert there
#   - user `gss` uid/gid 1000 (GAME_UID); the game and hooks run as it, gss-init itself runs as root
#   - /data (bind mount), /gss/spec (ro mount: spec.json + files/), /gss/run (rw mount: init.sock)
# gss-init needs these capabilities when the agent drops the rest: CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL.
# Build context is the repo root. Published as ghcr.io/ionnet-dev/ionnet-gss-base:latest by
# .github/workflows/base-image.yml, only when its inputs changed (this folder, gss-init's Go files, the FROM images);
# `deno task images:build base` (images/build.sh) builds it locally.

FROM golang:1.27-trixie AS init
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY agent/ ./
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/ionnet-dev/ionnet-gss/agent/internal/version.Version=${VERSION}" -o /gss-init ./cmd/gss-init

FROM debian:trixie-slim
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl tar unzip xz-utils jq procps nftables; \
  if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
    apt-get install -y --no-install-recommends lib32gcc-s1 lib32stdc++6; \
  fi; \
  rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 gss && useradd --uid 1000 --gid 1000 --home-dir /data --no-create-home --shell /bin/sh gss \
  && mkdir -p /data /gss/spec /gss/run && chown 1000:1000 /data
COPY --from=init /gss-init /usr/local/bin/gss-init
ENV LANG=C.UTF-8
WORKDIR /data
# docker stop: gss-init stops the game gracefully (stop command or signal, then SIGKILL after stop.timeout).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/gss-init"]
