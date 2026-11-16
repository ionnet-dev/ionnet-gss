# syntax=docker/dockerfile:1
# Build the web app with npm (Iontronic is a git dependency Deno can't install), then run the panel on Deno.

FROM node:22-alpine AS client
RUN apk add --no-cache git
WORKDIR /app
COPY client/package.json client/package-lock.json client/.npmrc client/
RUN cd client && npm ci --no-audit --no-fund
# The client imports types straight from shared/ (Vite alias), so it is part of the build context.
COPY shared/ shared/
COPY client/ client/
RUN cd client && npm run build

# M5: the agent builds the panel serves to the install script (/api/agent/download/linux/<arch>).
FROM golang:1.27-alpine AS agent
RUN apk add --no-cache make
WORKDIR /app/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN make dist

FROM denoland/deno:2.9.6
# git: the panel clones and fetches definition sources (M3).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY deno.json deno.lock ./
COPY shared/ shared/
COPY server/ server/
# Resolve every dependency at build time; the container never fetches code at runtime (--cached-only below).
RUN deno install --frozen && deno cache --frozen server/src/index.ts server/src/migrate.ts
COPY --from=client /app/client/dist client/dist
COPY --from=agent /app/agent/dist agent/dist
COPY scripts/ scripts/
RUN mkdir -p /var/lib/ionnet-gss-panel && chown deno:deno /var/lib/ionnet-gss-panel
# HOST=0.0.0.0: inside the container; compose publishes the port on BIND_HOST (127.0.0.1 by default) only.
ENV DENO_ENV=production HOST=0.0.0.0 PORT=3200 CLIENT_DIST=client/dist DATA_DIR=/var/lib/ionnet-gss-panel
USER deno
EXPOSE 3200
CMD ["deno", "run", "--cached-only", "-A", "server/src/index.ts"]
