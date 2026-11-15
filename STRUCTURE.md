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
                       + 20261116000000-m2-servers.ts (sources.kind)
                       + 20261117000000-server-deleting.ts (state `deleting`, delete_keep_data)
                       + 20261118000000-server-private-network.ts (allow_private_network)
  models/              one class per file (declare attributes, initModel(), finders, serializers) + columns.ts
                       + index.ts (instance, init, every association)
  controllers/         one namespace per resource exporting `router`; ApiController mounts them
  gateways/agent/      AgentGateway (static: by host id), AgentConnection (envelope, phases), handlers/ (by type)
  gateways/live/       LiveGateway (static: push(event, data, audience))
  definitions/         DefinitionEngine (pure: parse, resolve extends, variables, limits, image, render, buildSpec),
                       DefinitionSync (load → validate → definitions rows), loaders/ (DefinitionLoader per Source.kind:
                       LocalLoader = games/; GitLoader = safe shallow git clone, M3), OptionsFetcher (M3:
                       options_from lists, https allowlist + cache)
  jobs/                sourceSync.ts (M3: interval sync of git sources)
  servers/             GameServerService: every server operation (access, quota, ports, provision, lifecycle,
                       console, agent state → rows + live events, reconcile after hello)
  lib/                 HttpError, http (AppEnv, readBody, paramInt/Uuid, clientIp), RateLimiter, tokens, portPool, totp (M5)
client/                npm + Vite (Iontronic is a github: dep Deno can't install)
  vite.config.ts       :5200, HMR direct, aliases @/ @shared/, inline theme boot
  src/main.tsx         providers + auth bootstrap + <Router>
  src/routes.tsx       route table: regex paths, lazy pages, requirement() guards
  src/router/          Router.tsx (Router, Link, navigate, useLocation)
  src/Api/             BaseApi.ts (token+user in localStorage, GET/POST/…) + AuthApi, UserApi, InviteApi, HostApi,
                       ServerApi, DefinitionApi (M2)
  src/controllers/     Controller (notify), AuthController (session, permissions)
  src/hooks/           useController, useAuth, useResource (load + reload + live-event refetch)
  src/live/            LiveSocket (the /ws/live client, on(event))
  src/components/      AppLayout (AppShell/Sidebar/TabBar), AuthLayout
  src/pages/<Name>/    Login, Setup, Register, Hosts, HostDetail, Users, Invites, Account, NotFound;
                       M2: Servers (also `/`), ServerCreate, ServerDetail; component Console; M3: Sources
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
  internal/servers     Manager (manager.go), New(Options) + container/network naming and labels (new.go) (M2),
                       egress.go (bridge names, egress checks before a container or game starts)
  internal/images      Resolver: image ensure + derived `packages:` images, ionnet-gss-derived:<hash16> (M3)
  internal/stacks      Stack: a server's service containers (Ensure/Start with health wait/Stop/Remove/Status) (M3)
  internal/egress      Firewall: the agent's nftables table `inet ionnet_gss` (ruleset.go: pure script builder;
                       firewall.go: desired state, incremental adds, rebuilds, nft helper container)
  internal/initd       gss-init: Supervisor (initd.go), Console/Game/Launcher/RconClient interfaces (parts.go),
                       steps/ (install step registry), configs/ (format registry)
  internal/paths       host paths (Layout)
  packaging/           gss-agent.service
images/                build.sh (deno task images:build; local tags only), base/ (Dockerfile builds gss-init from
                       agent/; Dockerfile.dockerignore; has nftables for the agent's nft helper), minecraft-server/
                       (ARG JAVA → :java8/17/21/25)
games/                 built-in definition source: README.md, minecraft-java/{game.yml, hooks/install.sh},
                       M3: garrys-mod/game.yml, garrys-mod-mysql/{game.yml, templates/gss_database.json}
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
- Frame and console limits (one set, in the schemas, used by gss-init, agent and panel): `MAX_FRAME_BYTES` (4 MiB,
  either channel), `CONSOLE_LINE_MAX_BYTES` (8 KiB: gss-init splits longer output at a UTF-8 boundary, the panel
  cuts a longer line instead of refusing its batch), `CONSOLE_BATCH_MAX_LINES` (500) and `CONSOLE_BATCH_MAX_BYTES`
  (1 MiB of encoded lines) per `server.console` batch and per backlog answer. Go encodes every frame with
  `protocol.Marshal` (no HTML escaping: `<>&` stay one byte). Backlogs page: `InitBacklogRequest { afterSeq,
  beforeSeq, limit, tail }` → `{ lines, more }`; the agent catches up page by page after a restart, browsers page
  back with `GET …/console?before=<first seq>`.
- Buffers are bounded by bytes: the agent's outbox (64 MiB; console first, then player events; state changes never
  dropped), the supervisor client's queue (8 MiB / 10000 console lines, then a `Gap` that the agent fills from the
  backlog), live sockets (closed with `LIVE_CLOSE.TOO_SLOW` past 4 MiB unsent; at most 16 per user, `TOO_MANY`).
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

## M2: first server

### Run flow and contracts

```
browser ─POST /api/servers─► ServerController ─► GameServerService.create
   access + SERVERS_CREATE + grant ─► DefinitionEngine.resolveVariables/resolveLimits ─► Quota.assertFits (no-op
   until M5) + host capacity ─► PortAllocation.allocate ─► row (creating) ─► DefinitionEngine.buildSpec
   ─► AgentGateway.request("server.provision", { spec, specHash, reinstall: true })
agent: servers.Manager.Provision ─► <root>/servers/<id>/{data, spec/spec.json + spec/files/**, run/}
   ─► image (inspect; pull only if missing) ─► network gss-<id> ─► container gss-<id> (limits, CapDrop ALL, binds,
   ports host=container) ─► start ─► gss-init: install steps ─► state events
gss-init ─state/console (NDJSON, /gss/run/init.sock)─► agent ─server.state / server.console─► panel
   ─► GameServerService.applyStateChange (row + `server.state` live) / forwardConsole (`server.console` to topic
   `server:<id>`)
```

- **Container layout:** host `<root>/servers/<id>/data` → `/data` (rw), `spec/` → `/gss/spec` (ro: `spec.json` =
  `InitSpec`, `files/<definition-relative path>`), `run/` → `/gss/run` (rw, `init.sock`). Names and labels:
  `agent/internal/servers/new.go`.
- **Host permissions:** the server folder and `run/` are the agent's, 0700; the agent writes its uid/gid into
  `InitSpec.agentUid/agentGid` and gss-init hands `run/` (0700) and `init.sock` (0600) to them, so no other host user
  can reach the socket or the data. In-container peers are refused by pid (`peerError`). Ownership per agent uid:
  `agent/internal/servers/fs.go`.
- **Templates are rendered by the panel.** The agent and gss-init never see `{{…}}`. Hook files travel in
  `ServerSpec.files`; template configs travel rendered in `ConfigMapping.content`.
- **Images:** bare `ionnet-gss-*` in game.yml → `${IMAGE_REGISTRY}/ionnet-gss-*` (`:latest` when untagged).
  `images/build.sh` tags locally; agents pull only when an image is missing.
- **States:** gss-init owns `installing → stopped ⇄ starting → running → stopping`, `install_failed`, `crashed`; the
  panel row starts as `creating` and ends as `deleting` (below). A stop during `installing` cancels the install
  (→ `install_failed`); an install running longer than `install_timeout` (default `INIT_INSTALL_TIMEOUT_SEC`, 2 h)
  is cancelled the same way. A stop the agent starts itself (disk limit) carries its reason into the final `stopped`. `installProgress` (step/total/name) is in `ServerStatus`, `StateChange`,
  `InitStatus` and the `server.state` live event.
- **Reconnect:** `hello.servers` is the agent's inventory; `GameServerService.reconcile` re-provisions stopped servers
  whose `specHash` differs, deletes tombstones, and never deletes unknown ones. An agent restart reattaches to
  sockets and catches up with paged `backlog(afterSeq)`. `Restore` says hello after at most ~25 s even when a
  container is slow or an image is being pulled (bounded by `PROVISION_TIMEOUT_SEC`); late servers report through
  state changes.
- **Tombstones:** delete, and a create rolled back (provision failed, timed out or the host dropped mid-way), turn
  the row into state `deleting` with its ports still allocated. The row goes only when the agent confirms
  `server.delete` (or says it doesn't know the server); until then it is retried every minute while the host is
  online and on every hello, and reconcile never provisions it. Timeouts: the panel waits `PROVISION_TIMEOUT_SEC` +
  30 s for a provision (the agent gives up first and answers), and for restart/delete the definition's
  `stop.timeout` + 15 s (`docker stop` grace) + 90 s.
- **Disk:** the soft `limits.diskMb` is checked at start (409) and about once a minute while running (one server at a
  time, in its own goroutine); a running server over it is stopped with the measured size as `stateReason`.
- **Settings** change only while stopped (409 otherwise) and re-provision; a `reinstall` variable sets
  `reinstall: true`.
- **Console:** the client subscribes to `server:<id>` (LiveGateway handles a socket's frames one at a time, checks
  `GameServerService.canAccess`, answers `subscribed`), then `GET /api/servers/:id/console`, and dedupes by `seq`
  (a lower `seq` with a later `at` is a new gss-init process). Input is `POST /api/servers/:id/console`, at most 30
  commands per 10 s per server (429).
- **Templates:** `{{vars.x|sh}}` (POSIX single-quoted) and `{{vars.x|json}}`; a string/secret variable or
  `server.name` unfiltered in `start`, `stop.command` or a hook path fails definition validation (`games/README.md`).
  Number variables take `min`/`max` (400 outside, shown by the form).
- **Not in M2:** stats (M4), derived images for `packages` (the agent answers `unsupported`), `steamcmd`,
  `options_from`, config formats other than `properties` and `template` (M3).

### Egress filtering

By default a server's containers reach only the public internet. `game_servers.allow_private_network` (default
false; `GameServerDto.allowPrivateNetwork`) opts a server out. Only SERVERS_PRIVATE_NETWORK (held by `admin`) may
send it on create/update (403 otherwise, even for the current value); it is audited (`server.created` /
`server.updated` details), changes only while stopped, and travels as `ServerSpec.allowPrivateNetwork`, so it is part
of the spec hash and a change re-provisions. An agent that gets no field treats the server as restricted.

- **Table:** `inet ionnet_gss`, owned completely by the agent (`internal/egress`). Docker's tables and the operator's
  rules are never read, flushed or reordered. Base chains `forward` and `input` at priority `filter - 10` (before
  iptables-nft's filter chains at 0); an accept there only skips our checks, Docker's chains still run.
  - `set restricted` (ifname): bridges of restricted servers. `set intra` (ifname . ifname): the same bridge in and
    out. `set private4` / `set private6` (interval): 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
    192.168/16, 224/4, 240/4; ::, ::1, ::ffff:0:0/96, fc00::/7, fe80::/10, fec0::/10, ff00::/8.
  - `forward`: `ct state established,related accept` (replies to players on private LANs who came in through a
    published port) → not from a restricted bridge: accept → `iifname . oifname @intra` accept (game ↔ its stack's
    containers) → out through `docker0` or `gss-*`: reject → private destination: reject.
  - `input` (connections to the host itself: bridge gateway, LAN/public address, local services): not restricted:
    accept → established/related accept → ICMPv6 neighbour discovery accept → reject.
  - Rejects use `icmpx admin-prohibited`, so a blocked connect fails at once ("No route to host") instead of timing
    out. Docker's embedded DNS (127.0.0.11) is inside the container's namespace; Docker 26+ forwards its upstream
    queries from the host namespace (`ExtServers: [host(…)]`), so a private resolver keeps working.
- **Bridges:** new networks get `com.docker.network.bridge.name` = `gss-` + the first 11 hex digits of the server id
  (`servers.BridgeName`, 15 characters). Networks an older agent made keep `br-<network id>`; the agent reads the
  real name from the network inspect, so they are filtered too. Interface names are validated (`egress.ValidBridge`)
  and are the only variable part of the script.
- **Applying:** `nft -f` runs in a short-lived helper container (`egress.HelperRunner`): `helperImage` from the
  agent config (default `ghcr.io/ionnet-dev/ionnet-gss-base:latest`, pulled only when missing), `--network host`,
  root with every capability dropped but NET_ADMIN, no-new-privileges, the script bind-mounted read-only from
  `<dataRoot>/netfilter/ruleset.nft`; label `ionnet-gss.helper` (leftovers removed at Restore). No host `nft` fast
  path: one code path for root and docker-group agents.
- **When:** `Restore` rebuilds the whole table atomically (`add table; delete table; table { … }` in one transaction)
  from the servers on disk before it starts any container, and waits for it before hello. Creating a network or
  starting a restricted server's container or game adds its bridge incrementally (`add element`, idempotent; skipped
  when applied in the last 30 s); a failed add (table gone) falls back to a rebuild. Allowing private access and
  deleting a server remove the entry with a rebuild. Containers of servers the agent has no folder for stay out.
- **Fail closed:** when the table can't be applied, a restricted server's container and game don't start: the
  request gets a 409 with the cause and the agent re-sends the current state with it as `stateReason`. Allowed
  servers start anyway. A broken table is retried every minute (`Firewall.Heal`). Host facts carry
  `egress { filtering, restricted, error, checkedAt }` (null before the first apply, or from an older agent); the
  panel validates it and shows it on the Host page with a warning when it doesn't work.
- **Limits:** one agent per host manages the table (a second agent's rebuild drops the first one's bridges). The
  table is kernel state: after a reboot Docker restarts game containers (`unless-stopped`) before the agent rebuilds
  it, so gss-init (and an install it resumes) runs unfiltered for those seconds; games don't start until the agent
  says so. An operator who flushes the whole ruleset (e.g. `systemctl restart nftables` with `flush ruleset`) also
  removes this table; the next restricted start notices and rebuilds it. Hosts need nf_tables with `nft_ct`,
  `nft_reject_inet` and set support (stock Debian/Ubuntu/Arch kernels).

### API routes (M2)

Access: `O` = owner or SERVERS_MANAGE_ALL (else 404).

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/definitions | S | | `DefinitionDto[]` (active) |
| GET | /api/definitions/:id | S | | `DefinitionDto` |
| GET | /api/servers | S | | `GameServerDto[]` (own; all with SERVERS_MANAGE_ALL) |
| POST | /api/servers | P:SERVERS_CREATE | `CreateServerBody` | 201 `GameServerDetailResponse`; 400, 403 grant or `allowPrivateNetwork` without SERVERS_PRIVATE_NETWORK, 409 quota/capacity/ports/offline/egress |
| GET | /api/servers/:id | O | | `GameServerDetailResponse` |
| PATCH | /api/servers/:id | O | `UpdateServerBody` | `UpdateServerResponse`; 403 `allowPrivateNetwork` without SERVERS_PRIVATE_NETWORK; 409 not stopped |
| POST | /api/servers/:id/start | O | | `GameServerDto`; 409 offline/running/disk |
| POST | /api/servers/:id/stop | O | `StopServerBody` | `GameServerDto` (also cancels an install) |
| POST | /api/servers/:id/restart | O | | `GameServerDto` |
| POST | /api/servers/:id/reinstall | O | | `GameServerDto`; 409 running |
| DELETE | /api/servers/:id?keepData=true | O | | `OkResponse` (202: host didn't answer in time, stays `deleting`); 409 offline |
| GET | /api/servers/:id/console?limit=&before= | O | | `ConsoleBacklogResponse` (`more`: page back with `before`) |
| POST | /api/servers/:id/console | O | `ConsoleInputBody` | `OkResponse`; 409 not running; 429 |

Live: `server.updated` (refetch), `server.state` (apply in place), `server.console` (topic `server:<id>`), frames
`subscribed` / `error { topic }`. Client routes: `/` and `/servers`, `/servers/new`, `/servers/<uuid>`.

### Boundaries added in M2

| From | May import | Never |
| --- | --- | --- |
| `server/src/servers/*` | `models/index.ts`, `definitions/*`, `AgentGateway`, `LiveGateway`, lib, `@shared` | Hono `Context` |
| `controllers/ServerController`, `DefinitionController` | `GameServerService`, models (definitions list), lib | `AgentGateway` directly |
| agent handlers `serverState.ts`, `serverConsole.ts`, `hello.ts` (reconcile) | `GameServerService` | models for servers directly |
| `definitions/loaders/*` | `node:fs`, models (types), lib | `DefinitionEngine` (DefinitionSync validates) |
| `agent/internal/servers` | `docker`, `supervisor`, `paths`, `protocol`, `egress` | `panel` (it reports through `Sink`) |
| `agent/internal/egress` | `docker`, `protocol` | `servers`, `panel` (no server knowledge: server id → bridge only) |
| `agent/internal/initd/**` | `protocol`, stdlib (+ `golang.org/x/sys` / a pty package if needed: ask main) | `docker`, `panel`, `servers` |

### Open hardening (not in M2)

- Per-server uids / user namespaces: every game runs as uid 1000 on the host kernel; with the agent also uid 1000 (dev
  setups) the game could open `/gss/run`, and only gss-init's pid check refuses it.
- Disk: hard quotas (XFS project quotas / a size-limited volume) and a read-only root filesystem instead of the
  once-a-minute soft check.

## M2 work split

Main-session-only files (same as M1, plus): `protocol/schema/*` (ask; the M2 contracts are fixed),
`server/src/controllers/ApiController.ts`, `server/src/migrations/*`, `server/src/index.ts`, `server/src/Config.ts`,
`client/src/routes.tsx`, `client/src/components/AppLayout/AppLayout.tsx`, `shared/api/{servers,definitions}.ts`,
`shared/live.ts`, `agent/go.mod` + `go.sum` (a pty dependency for A is added by main on request), `deno.json`.

| Parcel | Difficulty | Owns | Verify on its own |
| --- | --- | --- | --- |
| **A: gss-init + images** | **Hard** (PID 1, pty, signals, process groups, races): `builder-opus` | `agent/cmd/gss-init/**`, `agent/internal/initd/**` (incl. `steps/`, `configs/`), `images/**` | `make lint`; `deno task images:build`; `docker run --rm -v $PWD/scratch/data:/data -v $PWD/scratch/spec:/gss/spec:ro -v $PWD/scratch/run:/gss/run ghcr.io/ionnet-dev/ionnet-gss-minecraft-server:java21` with a hand-written `spec.json` (download + write steps, a `properties` mapping, `start: java -jar server.jar nogui`). Then a 30-line Go or Deno NDJSON client on `scratch/run/init.sock`: `status` → `install` → events until `stopped` → `start` → `running` on the ready pattern → `input "say hi"` → `backlog` → `stop` → `stopped`; `kill -9` the game → `crashed`; `docker stop` → graceful stop first; no zombies (`ps`) |
| **B: agent servers, Docker, supervisor client, handlers** | **Hard** (Docker API, reconcile, socket reattach): `builder-opus` | `agent/internal/{docker,servers,supervisor,agent}/**`, `agent/internal/paths/**`, `agent/internal/panel/**` (event buffering while offline) | `make lint`; a fake gss-init (`agent/internal/supervisor/fakeinit_test.go` style scratch program, or A's image once it exists) answering the socket. Drive the Manager from a scratch `cmd` (not committed) with a hand-written `ProvisionRequest`: folders and files written, container created with the right limits/caps/binds/ports (`docker inspect`), start/stop/restart/delete, agent restart → `Restore` reattaches, `Statuses()` correct. Then with a real panel: `server.provision` sent by hand from `deno eval` through `AgentGateway.request` |
| **C: panel definitions, servers, console fan-out, Minecraft definition** | Medium–hard (engine + orchestration): `builder` (escalate if stuck) | `server/src/definitions/**`, `server/src/servers/**`, `server/src/controllers/{Server,Definition}Controller.ts`, `server/src/gateways/agent/handlers/{serverState,serverConsole,hello}.ts`, `server/src/gateways/live/LiveGateway.ts` (subscribe case only), `server/src/models/{GameServer,Definition,Source,PortAllocation,Quota}.ts`, `games/**` | `deno task check`; a `src/test.ts`-style scratch script: parse + resolve + render `games/minecraft-java` to a `ServerSpec` and print it (no TODOs left in output). With the dev panel and **no agent**: `GET /api/definitions` lists minecraft-java; `POST /api/servers` → 409 offline and no row left; with a scratch WebSocket client acting as the agent (hello with a real host credential, answers `server.provision` with a `ServerStatus`, then sends `server.state` / `server.console`): row states change, `server.state` and topic `server.console` reach a `/ws/live` client, a non-owner's subscribe is refused. Run `hooks/install.sh` locally in `docker run debian` with `GSS_VAR_*` to fetch vanilla and paper jars |
| **D: web app servers** | Medium: `builder` | `client/src/pages/{Servers,ServerCreate,ServerDetail}/**`, `client/src/components/Console/**` (+ new components such as `VariableForm/`, `ServerState/`), `client/src/Api/{Server,Definition}Api.ts`, `client/src/live/LiveSocket.ts` (topics) | `npm run typecheck && npm run build`; headless Playwright against `deno task dev` with route mocks (`page.route("/api/servers*")`) and a mocked `/ws/live` (or C's panel once it lands): list → create flow (form generated from the minecraft-java DefinitionDto) → detail with state badge and install progress → console renders backlog + live lines and sends input → settings disabled while running. Screenshots light + dark |

Order: all four in parallel. A and B meet at the socket protocol (`supervisor.json`), B and C at `server.json`, C
and D at `shared/api/servers.ts` and `shared/live.ts`. Integration (main): `deno task images:build`, one real
Minecraft server created from the UI on this machine, joinable at the shown address.

## M3: definitions

### Contracts

- **Sources.** `sources.kind` = `local` (the built-in `builtin` = GAMES_DIR, commit `"local"`, edit-only `enabled`)
  or `git` (https only, branch, subfolder `path`, optional write-only `authToken`, `syncIntervalMin`). Clones go in
  `AppSystem.sourcesDir/<id>`. Safety rules are in the `GitLoader` doc comment (protocol allowlist, no hooks,
  submodules or symlinks, header-only token, timeout, size and file limits). Sync = `DefinitionSync.syncSource`
  (one at a time per source; `jobs/sourceSync.ts` on the interval, `POST /api/sources/:id/sync` on demand). A
  game that fails validation keeps its previous active row; its error is in `definitionErrors[gameId]`.
- **Pinning and upgrade.** A server keeps its `definitionId` (one version). `updateAvailable` + `latestDefinition`
  on the detail; `POST /api/servers/:id/upgrade` while stopped re-resolves the variables and re-provisions
  (`reinstall` when the install steps or a `reinstall` variable changed).
- **`options_from`** (decided: panel-side fetcher, no hooks). `OptionsSource {url, items, value, where, include,
  reverse, limit}`; https host on OPTIONS_FETCH_HOSTS; ≤ 2 MiB; 10 s; cached OPTIONS_CACHE_MIN; static `options`
  first; on fetch failure the value must match the variable's new `pattern`. Route
  `GET /api/definitions/:id/options/:key`. Replaces the blueprint's `options_from: { hook }`.
- **steamcmd** (gss-init): per-server copy in `INIT_STEAMCMD_DIR` (`/data/.gss/steamcmd`), fetched from
  `STEAMCMD_URL`, anonymous login only, `+force_install_dir <dir>` (below /data), `+app_update <app> [-beta b]
  [validate]`, progress lines to the console, install progress per step. `server.update` (panel → agent) and
  supervisor `update` re-run only the steamcmd steps + the `update` hook while stopped (`POST /api/servers/:id/update`).
- **Config formats** (gss-init `configs/`): addressing per `ConfigFormat` (properties/cfg literal keys; ini
  `section.key`; json/yaml dotted paths). cfg = Source-engine `key "value"` lines (quotes escaped, comments kept).
  yaml uses `gopkg.in/yaml.v3` (in go.mod) node editing to keep comments. Only managed keys change; a missing file is
  created.
- **`packages:`** → `images.Resolver.Ensure`: generated Dockerfile only, names re-validated (`images.PackageName`, ≤
  50), cached as `ionnet-gss-derived:<hash16>`; build lines go to the console with `seq: 0`.
- **`services:`** → `stacks.Stack`: ≤ 4, containers `gss-<id>-<name>` on the server's bridge with alias `<name>`,
  never published, same hardening, `ServiceSpec.limits` (panel always fills them; they count toward quota usage),
  volume at `<server>/services/<name>`, healthcheck wait before the game starts. Status travels in
  `ServerStatus.services` (hello, every response) and the `server.services` event → `game_servers.services_status` →
  live `server.services`. The egress rules must keep intra-bridge traffic (game ↔ db) allowed.
- **Migration** `20261119000000-m3-sources.ts`: `sources.auth_token`, `sources.sync_interval_min`,
  `game_servers.services_status`.
- **Live:** `source.updated {sourceId, syncing}` (SOURCES_MANAGE), `definitions.updated {sourceId}` (everyone),
  `server.services {serverId, services}` (owner + SERVERS_MANAGE_ALL).

### API routes (M3)

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/sources | P:SOURCES_MANAGE | | `SourceDto[]` |
| POST | /api/sources | P:SOURCES_MANAGE | `CreateSourceBody` | 201 `SourceDto`; 400, 409 name |
| PATCH | /api/sources/:id | P:SOURCES_MANAGE | `UpdateSourceBody` | `SourceDto` (builtin: `enabled` only) |
| DELETE | /api/sources/:id | P:SOURCES_MANAGE | | `OkResponse`; 409 builtin or pinned servers |
| POST | /api/sources/:id/sync | P:SOURCES_MANAGE | | `SyncSourceResponse`; 409 already syncing |
| GET | /api/definitions/:id/options/:key | S | | `VariableOptionsResponse` |
| POST | /api/servers/:id/upgrade | O | `UpgradeServerBody` | `UpgradeServerResponse`; 409 not stopped, 400 values |
| POST | /api/servers/:id/update | O | | `GameServerDto`; 409 not stopped, 400 nothing to update |

`DefinitionDto` gains `sourceKind` and `isStack`; `GameServerDetailResponse` gains `latestDefinition`, `source`,
`services` and `canUpdateGame`. Client route `/sources` (nav: Manage → Sources).

### Boundaries added in M3

| From | May import | Never |
| --- | --- | --- |
| `definitions/loaders/GitLoader.ts` | `Deno.Command("git")` with the fixed flags, `node:fs`, Config, AppSystem | a shell, `git` without the `-c` safety flags, the token in argv-visible URLs |
| `definitions/OptionsFetcher.ts` | `fetch` (allowlisted hosts), Config | hosts, hooks, the DB |
| `jobs/sourceSync.ts` | `DefinitionSync`, models | controllers |
| `agent/internal/images`, `stacks` | `docker`, `paths`, `protocol` | `panel`, `servers` (servers calls them) |
| `agent/internal/initd/configs`, `steps` | stdlib, `yaml.v3`, `datafs` (all file access below /data) | paths outside /data |

### Extension points (M3)

- `LOADERS` (`definitions/loaders/index.ts`): a new source kind = a `DefinitionLoader` + a `Source.KINDS` value
  (+ migration for the enum).
- `OptionsSource` selectors: new keys in `definition.json` + `OptionsFetcher.select`.
- `configs.Registry` / `steps.Registry` (gss-init), `stacks.Stack` (agent), `images.Resolver` (agent).

## M3 work split

Main-session-only files (as before, plus): `protocol/schema/*`, `agent/go.mod`/`go.sum` (yaml.v3 is already in),
`shared/api/{sources,servers,definitions}.ts`, `shared/live.ts`, `server/src/migrations/*`,
`server/src/{index,Config}.ts`, `ApiController.ts`, `client/src/routes.tsx`, `AppLayout.tsx`, `docker/docker.go`
(the `ContainerSpec.Healthcheck` / `ContainerInfo.Health` fields are fixed; B implements them in `containers.go`).

| Parcel | Difficulty / route | Owns | Verify on its own |
| --- | --- | --- | --- |
| **A: gss-init config formats + steamcmd + update** | Medium–hard (format-preserving edits, steamcmd quirks): `builder-opus` | `agent/internal/initd/configs/**` (ini, json, yaml, cfg appliers + tests), `agent/internal/initd/steps/steamcmd.go`, the `update` request in `initd` (server.go / initd.go), `images/base/**` if srcds needs more libs | `go test ./internal/initd/...` (table tests per format: keeps comments and unmanaged keys, creates missing files, refuses paths outside /data); `deno task images:build base`, then `docker run` the base image by hand with a hand-written spec holding one `steamcmd: { app: 4020 }` step and the NDJSON scratch client from M2: `install` → progress lines → `stopped`, `/data/.gss/steamcmd` exists, then `update` re-runs only steamcmd |
| **B: agent derived images + stacks + egress interplay** | Hard (Docker build API, health waits, reconcile, nftables): `builder-opus` | `agent/internal/{images,stacks}/**`, `agent/internal/servers/**` (wiring: provision → Resolver + Stack, start order, Statuses with services, `server.services` events, `server.update` passthrough), `agent/internal/docker/**` except the fixed struct fields, `agent/internal/egress/**` (intra-bridge allow), `agent/internal/agent/agent.go` (MsgServerUpdate handler) | `make lint`, `go test ./...`; scratch driver with a hand-written `ProvisionRequest` that has `packages: [jq]` and `services.db: mariadb:11.4` + healthcheck: derived image built once (second provision reuses it), `docker inspect` shows service hardening/limits/alias/no ports, game waits for healthy, `docker exec gss-<id> getent hosts db` resolves and connects while other servers' bridges can't, egress table still blocks private ranges; stop/remove order; `Statuses()` lists services |
| **C: panel sources, pinning/upgrade, options_from, Garry's Mod definitions** | Medium–hard (git safety, upgrade semantics): `builder` (route GitLoader review to the reviewer) | `server/src/definitions/**`, `server/src/jobs/**`, `server/src/servers/**`, `server/src/controllers/{Source,Definition,Server}Controller.ts`, `server/src/gateways/agent/handlers/{serverServices,hello}.ts`, `server/src/models/{Source,Definition,GameServer}.ts`, `games/garrys-mod*/**` | `deno task check`; scratch script: `DefinitionEngine` parses/resolves both Garry's Mod definitions (extends merge, services limits filled, `|sh`/`|json` rendered) and prints the `ServerSpec`; `OptionsFetcher.select` on saved Mojang/Paper JSON. Dev panel without an agent: add a public https git source (a throwaway repo with one valid and one broken game) → sync → `definitionErrors` shows the broken one, the valid one is listed; push a change → sync → old servers keep their version, `updateAvailable` true; `file://`, `ssh://`, `http://`, submodule and oversized repos all refused. Fake-agent WebSocket from M2 for `upgrade`/`update`/`server.services` |
| **D: client** | Medium: `builder` | `client/src/pages/{Sources,ServerCreate,ServerDetail}/**`, `client/src/components/**` (except `AppLayout`), `client/src/Api/{Source,Definition,Server}Api.ts` | `npm run typecheck && npm run build`; headless Playwright with mocked routes and socket: Sources page (add, sync, errors per game), picker shows source + version + stack badge, a select with `options_from` loads `getOptions` (and falls back to free text with the `pattern` hint on error), server page "Update available → Apply" (disabled unless stopped), "Update game" for steamcmd games, services list with state badges updating on `server.services`; screenshots light + dark |

Order: all four in parallel. A ↔ B meet at `supervisor.json` (`update`), B ↔ C at `server.json` (`server.update`,
`server.services`, `ServiceSpec`), C ↔ D at `shared/api/*` and `shared/live.ts`. Integration (main): images rebuilt,
a git source with both Garry's Mod games synced, `garrys-mod-mysql` created from the UI, MySQLOO-style connection to
`db` works, upgrade after a pushed change.
