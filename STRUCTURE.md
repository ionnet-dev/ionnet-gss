# Ionnet GSS structure

Game server manager: panel (Deno + Hono + Sequelize/MariaDB + React/Iontronic), Go agent per host, gss-init (PID 1)
per game container. The design is in `docs/blueprint.html`; this file is the code map.

## Tree

```
deno.json              imports (@shared/, hono, sequelize, mysql2, umzug, bcryptjs, @std/yaml) + tasks; fmt disabled
docker-compose.yml     panel + mariadb (healthcheck, named volumes)
docker-compose.dev.yml MariaDB only, 127.0.0.1:3308
Dockerfile             node stage builds client/, deno stage runs server/ and serves client/dist
.env.example           every variable, grouped under ##### banners (defaults = dev)
protocol/
  schema/*.json        JSON Schema: envelope (frame, channels, close codes), host (M1), server (M2),
                       definition (game.yml blocks), supervisor (agent↔gss-init, M2)
  generate.ts          generator → shared/protocol/protocol.gen.ts + agent/internal/protocol/protocol_gen.go
shared/                types + consts used by server and client (no runtime deps)
  constants.ts         APP_NAME, TOKEN_PREFIX, LIMITS, LIVE_CLOSE
  permissions.ts       PERMISSIONS (UPPER_SNAKE keys), ROLES, DEFAULT_USER_PERMISSIONS
  live.ts              /ws/live: LiveEvents map, client/server frames, topics
  api/*.ts             REST DTOs: common, meta, auth, users (+roles, quota), invites, hosts (+enrol tokens, grants)
  protocol/protocol.gen.ts  GENERATED, never edit
  index.ts             barrel (for deno check)
server/src/
  index.ts             data dirs → DB → migrations → gateways → Deno.serve
  App.ts               onError → { message }, /api, /ws, Vite proxy (dev) / client/dist + index.html (prod)
  Config.ts            env → typed Config (HOST, limits; no JWT_SECRET → generated once into DATA_DIR/jwt-secret)
  AppSystem.ts         name, version, data folders
  migrate.ts           Umzug runner + CLI (deno task migrate up|down|pending|executed|create <name>)
  migrations/          index.ts (explicit list) + 20261115000000-initial.ts (whole v1 schema, seeds admin/user roles)
  models/              one class per file (declare attributes, initModel(), finders, serializers) + columns.ts
                       + index.ts (instance, init, every association)
  controllers/         one namespace per resource exporting `router`; ApiController mounts them
  gateways/agent/      AgentGateway (static: by host id), AgentConnection (envelope, phases), handlers/ (by type)
  gateways/live/       LiveGateway (static: push(event, data, audience))
  definitions/         DefinitionEngine (M2): parse → resolve extends → render → ServerSpec
  lib/                 HttpError, http (AppEnv, readBody, paramInt/Uuid, clientIp), RateLimiter, tokens, portPool, totp (M5)
client/                npm + Vite (Iontronic is a github: dep Deno can't install)
  vite.config.ts       :5200, HMR direct, aliases @/ @shared/, inline theme boot
  src/main.tsx         providers + auth bootstrap + <Router>
  src/routes.tsx       route table: regex paths, lazy pages, requirement() guards
  src/router/          Router.tsx (Router, Link, navigate, useLocation)
  src/Api/             BaseApi.ts (token+user in localStorage, GET/POST/…) + AuthApi, UserApi, InviteApi, HostApi
  src/controllers/     Controller (notify), AuthController (session, permissions)
  src/hooks/           useController, useAuth, useResource (load + reload + live-event refetch)
  src/live/            LiveSocket (the /ws/live client, on(event))
  src/components/      AppLayout (AppShell/Sidebar/TabBar), AuthLayout
  src/pages/<Name>/    Login, Setup, Register, Hosts, HostDetail, Users, Invites, Account, NotFound
agent/                 Go module github.com/ionnet-dev/ionnet-gss/agent
  cmd/gss-agent        enrol | run | version | help
  cmd/gss-init         PID 1 in game containers (M2)
  internal/protocol    protocol_gen.go (GENERATED) + envelope.go (build/decode envelopes, NDJSON frames)
  internal/cli         subcommands (Commands table)
  internal/agent       run wiring: session, heartbeat, panel→agent handlers
  internal/panel       WebSocket dial, Enrol, reconnecting Session
  internal/config      config file Store (/etc/ionnet-gss/agent.json)
  internal/hostfacts   Collector (+ _linux.go / _other.go)
  internal/docker      Engine API client over the unix socket (net/http only)
  internal/supervisor  agent's client for gss-init's socket (M2)
  internal/servers     Manager: server lifecycle on the host (M2)
  internal/initd       gss-init: Supervisor, steps/ (install step registry), configs/ (format registry)
  internal/paths       host paths (Layout)
  packaging/           gss-agent.service
images/, games/        (M2/M3) base + minecraft-server images; starter definitions
docs/                  blueprint.html
```

## Boundaries

| From | May import | Never |
| --- | --- | --- |
| `shared/` | other `shared/` files | server, client, Deno/DOM APIs, npm packages |
| `server/src/models/*.ts` | sequelize, `columns.ts`, lib, `@shared`, other models (types; classes only inside methods) | controllers, gateways, Hono `Context` (except `User.$middleware`) |
| `server/src/controllers/*` | `models/index.ts`, lib, `AgentGateway`, `LiveGateway`, `DefinitionEngine`, `@shared` | `AgentConnection`, sockets, raw SQL |
| `server/src/gateways/agent/*` | `models/index.ts`, lib, `LiveGateway`, `@shared` | controllers |
| `server/src/definitions/*` | `@shared`, lib, `@std/yaml` | models, gateways (pure) |
| anything → hosts | `AgentGateway.request/isOnline/disconnect` | `AgentConnection` directly |
| anything → browsers | `LiveGateway.push()` | the live sockets |
| models from outside `models/` | `../models/index.ts` | `../models/User.ts` directly (init may not have run) |
| `client/src/pages`, `components` | `@/Api/*` (+ hooks), `@/hooks/*`, `@/router`, Iontronic, `@shared` types | `fetch`, `localStorage`, server code |
| `client/src/Api/*` | `BaseApi`, `@/hooks/useResource`, `@shared` types | React components |
| agent `cmd/*` | `internal/cli`, `internal/initd` | business logic in main |
| agent `internal/*` | `internal/protocol`, siblings by interface | hand-written copies of protocol structs |

UI: Iontronic components and `--io-*` variables only; icons from `@ionnet/iontronic/icons`. No polling: refetch on
live events (`useResource({ liveEvents })`).

## Protocol

- Envelope: `{ kind: request|response|event, id?, type?, data?, ok?, error? }`. Request ids are sender-unique
  (`a-1` agent, `p-1` panel). Responses echo `id` + `type`; absent `ok` means false.
- Agent channel: agent dials `wss://<PUBLIC_URL>/ws/agent` (plain `ws://` only for loopback panels or after
  `enrol --insecure`, remembered in the agent config). First frame must be `enrol` (then close 4000) or `hello` (then
  `ready`). A failed first request is answered and always closes the socket; no successful one within
  `HELLO_TIMEOUT_SEC` closes with `CLOSE_HELLO_TIMEOUT`. Close codes in `envelope.json` (`CLOSE_*`). The agent
  collects facts before dialling. Heartbeat every `heartbeatSec` (from hello response).
- Agent reconnect policy (`panel.classify`): hello answered `unauthorized` (unknown host or credential) → exit 3, the
  only fatal case; hello answered `forbidden` (host disabled) or `CLOSE_REVOKED` → retry every 60 s, so re-enabling
  needs no restart; every other failure or close code → backoff 1-60 s.
- Heartbeats push `host.updated` only when list-visible facts change (`Host.materialFacts`: versions, OS, totals),
  otherwise `host.facts` (usage, detail page only) at most once a minute per host. Online state is `host.status`.
- Supervisor channel: NDJSON on `/gss/run/init.sock` inside the container (host:
  `/var/lib/ionnet-gss/servers/<uuid>/run/init.sock`); spec at `/gss/spec/spec.json` (ro), data at `/data`.
- Generated maps: `AgentToPanelRequests`, `AgentToPanelEvents`, `PanelToAgentRequests`, `PanelToAgentEvents`,
  `AgentToInitRequests`, `InitToAgentEvents` (TS); `Msg*` / `InitMsg*` consts + `Messages` (Go).
- Generator subset is documented at the top of `protocol/generate.ts` (inline objects refused: name them in `$defs`).

## Auth

bcrypt (`bcryptjs`, passwords 10 characters to 72 UTF-8 bytes: `passwordProblem()` in `shared/constants.ts`), JWT
HS256 (`hono/jwt`, `JWT_SECRET`, or a random one kept in `DATA_DIR/jwt-secret`) as `Authorization: Bearer`. Claims
`{ sub, ver, purpose, exp }`; `ver` = `users.token_version`, bumped on password change/disable/role change to end
sessions. Roles many-to-many (`user_roles`), may inherit (`inherits_id`); `admin` passes every check. Guard:
`User.$middleware({ required, admin, permissions })`. TOTP: `purpose: "totp"` challenge JWT → `/auth/login/totp` (M5).
Secrets the panel issues (`gss_enrol_`, `gss_host_`, `gss_inv_`) are stored as SHA-256 only (`lib/tokens.ts`).

- Delegation: non-admins never change, reset or delete an admin, and grant or remove only roles whose resolved
  permissions they hold (`User.assertMayAssignRoles`: users, invites).
- Last admin and first-run setup: checked inside a transaction after `User.lockAdminChanges()` (row lock on the
  `admin` role).
- Role change: other users are signed out (live close `UNAUTHORIZED`); editing your own roles returns
  `UpdateUserResponse.token`, which the client adopts (`AuthController.adoptSession`). A 401 or live 4401 for a token
  that is no longer the stored one doesn't sign out (`BaseApi`, `LiveSocket`).
- Limits: `/api` bodies over `BODY_LIMIT_KB` → 413. In-memory limits (`lib/RateLimiter.ts`, `RATE_LIMIT_*`): login per
  IP and failed logins per username, setup/register/invite preview per IP → 429 `{ message }` + `Retry-After`;
  refused logins aren't audited. Client IP from `X-Forwarded-For` only with `TRUST_PROXY`.

## API routes (M1)

Auth: `-` public, `S` signed in, `P:<KEY>` permission, `RL` rate-limited (429). Errors: `{ message }`; any `/api`
body over `BODY_LIMIT_KB` → 413.

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/health | - | | `HealthResponse` (503 DB down) |
| GET | /api/meta | - | | `MetaResponse` |
| GET | /api/auth/status | - | | `AuthStatusResponse` |
| POST | /api/auth/setup | - (no users), RL | `SetupBody` | 201 `LoginSuccess`; 409 |
| POST | /api/auth/login | -, RL | `LoginBody` | `LoginResponse`; 401 |
| POST | /api/auth/login/totp | - | `TotpLoginBody` | `LoginSuccess` (M5) |
| GET | /api/auth/invite/:code | -, RL | | `InvitePreviewResponse` |
| POST | /api/auth/register | -, RL | `RegisterBody` | 201 `LoginSuccess`; 400 |
| GET | /api/auth/me | S | | `UserDto` |
| POST | /api/auth/password | S | `ChangePasswordBody` | `LoginSuccess`; 401 |
| POST | /api/auth/totp/setup·confirm·disable | S | | M5 |
| GET·POST | /api/users | P:USERS_MANAGE | `CreateUserBody` | `UserDto[]` / 201 `UserDto`; 403 role |
| PATCH·DELETE | /api/users/:id | P:USERS_MANAGE | `UpdateUserBody` | `UpdateUserResponse` / `OkResponse`; 403 admin target or role; 409 last admin |
| POST | /api/users/:id/password | P:USERS_MANAGE | `SetUserPasswordBody` | `OkResponse`; 403 admin target |
| GET·PUT | /api/users/:id/quota | P:USERS_MANAGE | `UpdateQuotaBody` | `EffectiveQuotaDto` (M5) |
| GET | /api/roles | P:USERS_MANAGE or INVITES_MANAGE | | `RoleDto[]` |
| GET·POST | /api/invites | P:INVITES_MANAGE | `CreateInviteBody` | `InviteDto[]` / 201 `InviteCreatedResponse`; 403 role |
| DELETE | /api/invites/:id | P:INVITES_MANAGE | | `OkResponse`; 409 used |
| GET | /api/hosts | S (+HOSTS_VIEW: granted only) | | `HostDto[]` |
| GET | /api/hosts/:id | S | | `HostDetailResponse` |
| PATCH·DELETE | /api/hosts/:id | P:HOSTS_MANAGE | `UpdateHostBody` | `HostDetailResponse` / `OkResponse`; 409 servers |
| GET·PUT·DELETE | /api/hosts/:id/grants[/:userId] | P:HOSTS_MANAGE | | M5 |
| GET·POST | /api/enrol-tokens | P:HOSTS_MANAGE | `CreateEnrolTokenBody` | `EnrolTokenDto[]` / 201 `EnrolTokenCreatedResponse` |
| DELETE | /api/enrol-tokens/:id | P:HOSTS_MANAGE | | `OkResponse`; 409 used |
| GET | /ws/agent | first frame | protocol | protocol |
| GET | /ws/live | first frame `auth` | `LiveClientFrame` | `LiveServerFrame` |

Live events and audiences: `shared/live.ts`.

## Where does new X go?

| New … | Files |
| --- | --- |
| API resource | `shared/api/<x>.ts`, `server/src/controllers/<X>Controller.ts`, one line in `ApiController.ts`, `client/src/Api/<X>Api.ts` |
| Model / table | `server/src/models/<X>.ts` (`initModel`), add to `models/index.ts` (init list + associations), migration via `deno task migrate create <name>` + entry in `migrations/index.ts` |
| Page | `client/src/pages/<Name>/<Name>.tsx` (+ `.scss`), entry in `routes.tsx`, nav item in `AppLayout` |
| Live event | `LiveEvents` in `shared/live.ts`, `LiveGateway.push()` at the source, `liveEvents` in the data hook |
| Protocol message | `x-messages` entry + `$defs` in `protocol/schema/<area>.json`, `deno task protocol`; panel side: `gateways/agent/handlers/<name>.ts` + registry line (agent→panel) or `AgentGateway.request()` call (panel→agent); agent side: entry in `internal/agent/agent.go` `handlers()` |
| Install step type | property on `InstallStep` in `definition.json`, `deno task protocol`, executor in `agent/internal/initd/steps/<name>.go` + `Registry` |
| Config format | value in `ConfigFormat` (`definition.json`), `deno task protocol`, applier in `agent/internal/initd/configs/<format>.go` + `Registry` |
| Agent subcommand | `agent/internal/cli/<name>.go` + entry in `Commands` |
| Permission | key in `shared/permissions.ts`; grant it to `user` through a migration if default |
| Setting (env) | `server/src/Config.ts` + `.env.example` (+ `docker-compose.yml`) |
| Host path | `agent/internal/paths` `Layout` method |

## Extension points

- `REQUEST_HANDLERS` / `EVENT_HANDLERS` (`gateways/agent/handlers/index.ts`): the mapped type forces a handler for
  every agent→panel request type.
- `Agent.handlers()` (Go): panel→agent request table; unknown types answer `unsupported`.
- `steps.Registry`, `configs.Registry` (gss-init).
- `LiveGateway.push(event, data, audience)` + `LiveEvents`; `useResource({ liveEvents, liveFilter })`.
- `requirement()` guards in `routes.tsx` (a refused route redirects to `homePath()`: `/` with HOSTS_VIEW, else
  `/account`); `User.$middleware()` on the server.
- `cli.Commands` (agent). `DefinitionEngine` is pure: sync (M3) and create (M2) both call it.
- Schema is v1-complete: `quotas`, `host_grants`, `server_shares`, `schedules`, `backups` exist now.

## Run and verify

```sh
deno task db:up                 # MariaDB on 127.0.0.1:3308
cd client && npm install        # once (.npmrc allow-git=root)
deno task dev                   # panel 127.0.0.1:3200 (proxies Vite :5200) — open http://localhost:3200
deno task build && deno task start  # production mode: serves client/dist, listens on 0.0.0.0 (HOST)
deno task migrate up            # also runs at startup (AUTO_MIGRATE)
deno task protocol              # regenerate after editing protocol/schema; commit the output
deno task check                 # deno check + protocol --check + deno lint + client tsc
deno task check:agent           # go build + go vet
cd agent && make build          # bin/gss-agent, bin/gss-init
echo gss_enrol_… | ./agent/bin/gss-agent enrol --panel http://localhost:3200 --token-stdin --config ./data/agent.json
./agent/bin/gss-agent run --config ./data/agent.json
```

M1 proof: create an enrol token in the panel, enrol this machine, `run` it, and the host shows online with facts.

## M1 work split

Shared files, main session only: `deno.json`, `deno.lock`, `client/package.json` + lock, `agent/go.mod` + `go.sum`,
`protocol/schema/*`, generated files, `shared/index.ts`, `server/src/{index,App,Config,AppSystem,migrate}.ts`,
`server/src/migrations/*`, `server/src/models/index.ts`, `server/src/models/columns.ts`,
`server/src/controllers/ApiController.ts`, `client/src/{main,routes}.tsx`, `client/src/router/*`,
`client/src/Api/BaseApi.ts`, `client/src/controllers/Controller.ts`, `client/src/hooks/useController.ts`,
`.env.example`, compose files, `Dockerfile`, this file. Need a change there (new dep, column, route, DTO field)?
Report it back instead of editing.

| Parcel | Owns | Verify |
| --- | --- | --- |
| **A: panel auth, users, invites, hosts REST, live gateway** | `server/src/models/{User,Role,Quota,Invite,EnrolToken}.ts` (except `findUsable`), `Host.ts` serializers (`toClientJSON`, `toDetailJSON`), `server/src/controllers/{Auth,User,Role,Invite,Host,EnrolToken}Controller.ts`, `server/src/gateways/live/LiveGateway.ts`, `server/src/lib/{http,tokens,portPool}.ts` (helpers only), `shared/api/{auth,users,invites,hosts}.ts` (field doc only) | `deno task check`; curl: setup → login → me → users CRUD → invite create/preview/register → enrol-token create (command string) → hosts list; a `wscat` on /ws/live gets `ready` after `auth` |
| **B: agent enrol/run/heartbeat + agent gateway** | everything in `agent/` except go.mod/go.sum/generated; `server/src/gateways/agent/**`; `Host.ts` `enrol`, `authenticateAgent`, `recordFacts`; `EnrolToken.findUsable` | `deno task check:agent`, `make lint`; against the dev panel: enrol with a token from A's route (or one inserted by hand), `run`, the host row gets facts and `lastSeenAt`, `AgentGateway.isOnline` true, kill the panel → agent backs off and reconnects; disabled host → retries every 60 s; removed host → exit 3 |
| **C: web app pages** | `client/src/pages/**`, `client/src/components/**`, `client/src/controllers/AuthController.ts`, `client/src/live/LiveSocket.ts`, `client/src/hooks/{useAuth,useResource}.ts`, `client/src/Api/{Auth,User,Invite,Host}Api.ts` | `cd client && npm run typecheck && npm run build`; headless Playwright against `deno task dev`: setup → hosts empty state → enrol dialog shows command → users/invites CRUD; screenshots of Hosts and HostDetail light + dark |

Order: A and B and C run in parallel against these contracts. C can stub responses until A lands; B can insert an
enrol token row by hand until A's route works. Integration (main): one real enrol on this machine, host online in
the UI.
