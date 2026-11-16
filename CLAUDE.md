# Ionnet GSS: notes for coding agents

Game server manager (panel + Go agent + gss-init). Read `STRUCTURE.md` first (tree, boundaries, routes, where new
things go, parcel ownership). The design is `docs/blueprint.html`.

## Commands

```sh
deno task db:up / db:down   # MariaDB on 127.0.0.1:3308
deno task dev               # panel :3200, proxies Vite :5200 (client/ is npm: cd client && npm install)
deno task migrate up        # explicit list in server/src/migrations/index.ts
deno task protocol          # regenerate types from protocol/schema (commit the output); --check to verify
deno task check             # deno check + protocol --check + deno lint + client tsc
deno task check:agent       # go build + go vet in agent/
cd agent && make build      # bin/gss-agent, bin/gss-init
```

## Conventions

- `games/` is a git submodule (the public `ionnet-dev/ionnet-gss-games`, the official definition source): commit and
  push definition changes there, then bump the submodule here. Panels from the Docker image sync that repo directly.

- Panel↔agent and agent↔gss-init shapes come only from `protocol/schema/*.json`. Never hand-edit
  `shared/protocol/protocol.gen.ts` or `agent/internal/protocol/protocol_gen.go`.
- Models: one class per file with `declare` attributes and `initModel()`; associations only in `models/index.ts`;
  import models from `models/index.ts`. Schema changes only through migrations.
- Controllers are namespaces exporting `router`; throw `HttpError` (→ `{ message }`). Hosts only through
  `AgentGateway`; browsers only through `LiveGateway.push()`.
- Client: Iontronic only, data through `Api/*` + `useResource`, live refetch, no polling.
- Don't run `deno fmt` or Prettier. Format by hand: 2 spaces, double quotes, `else` on a new line. Go is gofmt.
- No test frameworks: verify by running (curl, headless browser, the real agent).
