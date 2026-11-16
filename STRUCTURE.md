# Ionnet GSS structure

Game server manager: panel (Deno + Hono + Sequelize/MariaDB + React/Iontronic), Go agent per host, gss-init (PID 1)
per game container. The design is in `docs/blueprint.html`; this file is the code map.

## Tree

```
deno.json              imports (@shared/, hono, sequelize, mysql2, umzug, bcryptjs, @std/yaml, M7: nodemailer) + tasks; fmt disabled
docker-compose.yml     panel + mariadb (healthcheck, named volumes)
docker-compose.dev.yml MariaDB 127.0.0.1:3308; M7: Mailpit (SMTP 127.0.0.1:1025, inbox http://localhost:8025)
Dockerfile             node stage builds client/, deno stage runs server/ and serves client/dist
.env.example           every variable, grouped under ##### banners (defaults = dev)
protocol/
  schema/*.json        JSON Schema: envelope (frame, channels, close codes), host (M1), server (M2),
                       definition (game.yml blocks), supervisor (agent↔gss-init, M2), files + backup (M4)
  generate.ts          generator → shared/protocol/protocol.gen.ts + agent/internal/protocol/protocol_gen.go
shared/                types + consts used by server and client (no runtime deps)
  constants.ts         APP_NAME, TOKEN_PREFIX, LIMITS, LIVE_CLOSE
  permissions.ts       PERMISSIONS (UPPER_SNAKE keys), ROLES, DEFAULT_USER_PERMISSIONS
  live.ts              /ws/live: LiveEvents map, client/server frames, topics
  api/*.ts             REST DTOs: common, meta, auth, users (+roles, quota), invites, hosts (+enrol tokens, grants),
                       servers, definitions, sources; M4: files, backups, metrics; M7: settings
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
                       + 20261119000000-m3-sources.ts + 20261120000000-m5-tenancy.ts (totp_last_step, recovery_codes)
                       + 20261121000000-agent-updates.ts + 20261122000000-m7-email.ts (settings, email_tokens, users)
  models/              one class per file (declare attributes, initModel(), finders, serializers) + columns.ts
                       + index.ts (instance, init, every association); M5: RecoveryCode; M7: Setting, EmailToken
  controllers/         one namespace per resource exporting `router`; ApiController mounts them (M4: File, Backup,
                       Metrics below /servers/:id, Download at /downloads; M5: Quota at /quota, Totp at /auth/totp +
                       /users/:id/totp, Share below /servers/:id, Agent at /agent; M7: Email at
                       /auth/email + /auth/email-2fa, Settings at /settings)
  gateways/agent/      AgentGateway (static: by host id), AgentConnection (envelope, phases), handlers/ (by type)
  gateways/live/       LiveGateway (static: push(event, data, audience))
  definitions/         DefinitionEngine (pure: parse, resolve extends, variables, limits, image, render, buildSpec),
                       DefinitionSync (load → validate → definitions rows), loaders/ (DefinitionLoader per Source.kind:
                       LocalLoader = games/; GitLoader = safe shallow git clone, M3), OptionsFetcher (M3:
                       options_from lists, https allowlist + cache)
  jobs/                sourceSync.ts (M3: interval sync of git sources)
  hosts/               M6: AgentUpdater (agent build per host, manual + automatic update, status in memory)
  mail/                M7: Mailer (the SMTP relay from the `mail` setting; only nodemailer importer), templates (pure)
  servers/             GameServerService: every server operation (access, quota, ports, provision, lifecycle,
                       console, agent state → rows + live events, reconcile after hello); M4: ServerAccess (share-aware
                       levels), agentCall (agent codes → HTTP), FileService, BackupService, MetricsService + MetricRing;
                       M5: ShareService
  transfers/           M4: TransferRelay (browser HTTP ⇄ agent chunks, windowed), DownloadTickets (single-use links)
  lib/                 HttpError, http (AppEnv, readBody, paramInt/Uuid, clientIp), RateLimiter, tokens, portPool, totp (M5),
                       agentBuilds (M6: the builds in AGENT_DIST_DIR), secretBox (M7: AES-GCM for secrets in settings)
client/                npm + Vite (Iontronic is a github: dep Deno can't install)
  vite.config.ts       :5200, HMR direct, aliases @/ @shared/, inline theme boot
  src/main.tsx         providers + auth bootstrap + <Router>
  src/routes.tsx       route table: regex paths, lazy pages, requirement() guards
  src/router/          Router.tsx (Router, Link, navigate, useLocation)
  src/Api/             BaseApi.ts (token+user in localStorage, GET/POST/…, M4: PUT_TEXT, UPLOAD with progress) +
                       AuthApi, UserApi, InviteApi, HostApi, ServerApi, DefinitionApi (M2), SourceApi (M3),
                       FileApi, BackupApi, MetricsApi (M4), QuotaApi, ShareApi (M5), SettingsApi (M7)
  src/controllers/     Controller (notify), AuthController (session, permissions)
  src/hooks/           useController, useAuth, useResource (load + reload + live-event refetch)
  src/live/            LiveSocket (the /ws/live client, on(event))
  src/components/      AppLayout (AppShell/Sidebar/TabBar), AuthLayout, … M4: FileManager (+ FileEditor), BackupList,
                       MetricsPanel (+ MetricChart), PlayerList; M5: QuotaUsage, QuotaDialog, ServerSharing,
                       HostGrants, TwoFactorCard, TotpSetupDialog, QrCode,
                       M6: AgentBuild (badge), AgentUpdate (host page card)
  src/pages/<Name>/    Login, Setup, Register, Hosts, HostDetail, Users, Invites, Account, NotFound;
                       M2: Servers (also `/`), ServerCreate, ServerDetail; component Console; M3: Sources;
                       M7: Settings, ForgotPassword, ResetPassword, ConfirmEmail
agent/                 Go module github.com/ionnet-dev/ionnet-gss/agent
  cmd/gss-agent        enrol | run | version | help
  cmd/gss-init         PID 1 in game containers (M2)
  internal/protocol    protocol_gen.go (GENERATED) + envelope.go (build/decode envelopes, NDJSON frames)
  internal/cli         subcommands (Commands table)
  internal/agent       run wiring: session, heartbeat, panel→agent handlers (files.go: M4 file + transfer handlers)
  internal/panel       WebSocket dial, Enrol, reconnecting Session
  internal/config      config file Store (/etc/ionnet-gss/agent.json)
  internal/hostfacts   Collector (+ _linux.go / _other.go)
  internal/docker      Engine API client over the unix socket (net/http only)
  internal/supervisor  agent's client for gss-init's socket (M2)
  internal/servers     Manager (manager.go), New(Options) + container/network naming and labels (new.go) (M2),
                       egress.go (bridge names, egress checks before a container or game starts); M4: files.go
                       (Manager.Files), backup.go (operations, restore swap), stats.go (stats loop)
  internal/images      Resolver: image ensure + derived `packages:` images, ionnet-gss-derived:<hash16> (M3)
  internal/updater     M6: Updater (agent.update: download from the own panel, verify, stage, wait for idle, swap);
                       the restart is agent.ErrRestart → cli re-exec (reexec_unix.go)
  internal/stacks      Stack: a server's service containers (Ensure/Start with health wait/Stop/Remove/Status) (M3)
  internal/egress      Firewall: the agent's nftables table `inet ionnet_gss` (ruleset.go: pure script builder;
                       firewall.go: desired state, incremental adds, rebuilds, nft helper container)
  internal/initd       gss-init: Supervisor (initd.go), Console/Game/Launcher/RconClient interfaces (parts.go),
                       steps/ (install step registry), configs/ (format registry), players.go (M4)
  internal/files       M4: FS (one data folder through os.Root: list/stat/read/write/mkdir/rename/delete, uploads),
                       Transfers (open transfer table, idle sweep)
  internal/backups     M4: tar + zstd archives (Create/Extract, Matcher for `exclude`), pure
  internal/paths       host paths (Layout)
  packaging/           gss-agent.service
images/                build.sh (deno task images:build [base|games [game]|all]; local tags only), base/ (Dockerfile
                       builds gss-init from agent/; Dockerfile.dockerignore; has nftables for the agent's nft helper).
                       Published by .github/workflows/base-image.yml. Game images live in the games repo
                       (<game>/image/Dockerfile + image.yml), published by its Images workflow
games/                 git submodule of ionnet-dev/ionnet-gss-games (public, the official source): the built-in
                       source of a panel run from source; the Docker image has none and seeds the repo as a git
                       source (`DefinitionSync.seedOfficial`, `OFFICIAL_SOURCE_URL`). README.md, minecraft-java/{game.yml, hooks/install.sh},
                       M3: garrys-mod/game.yml, garrys-mod-mysql/{game.yml, templates/gss_database.json}
scripts/               install-agent.sh (M5: served by the panel at /api/agent/install.sh, Arch + Debian/Ubuntu)
docs/                  blueprint.html; M5: admin/ (install panel, add a host, game sources, users and quotas)
README.md              M5
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
| POST | /api/hosts/:id/agent/update | P:HOSTS_MANAGE | | `HostDetailResponse` (M6); 409 offline, no build for the arch, already up to date, agent too old |
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
| Sub-resource of a server (M4) | `controllers/<X>Controller.ts` with its own `User.$middleware()` (reuses the outer user), mounted in `ApiController` as `/servers/:id/<x>`; access through `ServerAccess.get(user, id, level)`; agent calls through `servers/agentCall.ts` |
| Raw (non-JSON) request body | a regex in the controller's `BODY_PATHS` + a branch in `App.ts`'s `/api/*` body-limit switch |
| Something to download | a `TransferRelay.DownloadSource` kind + `TransferSource` value (`files.json`) + the agent's `transfer.open` case; links via `DownloadTickets.issue` |

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
  Base published from this repo, game images from the games repo (GHCR, linux/amd64, untagged versions deleted after
  each build). Both rebuild only when their inputs changed (`.github/scripts/image-inputs.sh`, identical copy in the
  games repo): files, build args and the digests of the FROM images, stored as `dev.ionnet.gss.inputs*` labels. Agents pull when an image is missing and again before every install (`images.Resolver.Refresh`); the
  container is recreated when its image ID differs from the tag's (`ContainerInfo.ImageID`).
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
  time, in its own goroutine); a running server over it is stopped with the measured size as `stateReason`. The size
  is `data/` plus a stack's `services/` volumes (M3). Volumes the agent can't read (another uid, 0700, for a non-root
  agent) are measured by a short-lived `du -sb` container (the game's image, root with DAC_READ_SEARCH only, no
  network, read-only bind, label `ionnet-gss.measure`) at most every 5 minutes in the background; a start waits for the
  first measurement.
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

- **Table:** `inet ionnet_gss` (agent config `egressTable`, an nft identifier; a second agent on the same host, e.g. a
  test instance, needs its own), owned completely by the agent (`internal/egress`). Docker's tables and the operator's
  rules are never read, flushed or reordered. Its comment carries a revision hash of the fixed part (`egress.Revision`). Base chains `forward` and `input` at priority `filter - 10` (before
  iptables-nft's filter chains at 0); an accept there only skips our checks, Docker's chains still run.
  - `set restricted` (ifname): bridges of restricted servers. `set intra` (ifname . ifname): the same bridge in and
    out. `set private4` / `set private6` (interval): 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
    192.168/16, 224/4, 240/4; ::/96 (::, ::1, IPv4-compatible), ::ffff:0:0/96 (mapped), ::ffff:0:0:0/96 (SIIT),
    100::/64, 2001::/32 (Teredo), 2002::/16 (6to4), fc00::/7, fe80::/10, fec0::/10, ff00::/8, and every private4
    range embedded in NAT64 `64:ff9b::/96` (64:ff9b::10.0.0.0/104 …; public NAT64 destinations stay reachable).
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
  when applied in the last 30 s); a failed add (table gone) falls back to a rebuild. Every path that reaches gss-init
  (start, restart, update, provision/reinstall of a running container: `servers.up` / `ensureContainer`) checks the
  rules first, and a container the watcher sees (re)started is checked again (held back when that fails). Allowing
  private access and deleting a server remove the entry with a rebuild. Containers of servers the agent has no folder
  for stay out.
- **Check:** `Firewall.Heal` runs every minute: `nft -j list table` in the helper, compared with what the agent applied
  (revision comment, both base chains with their rule counts, private set sizes, exactly the restricted bridges in
  `restricted` and `intra`). A missing or different table is rebuilt at once (logged as a warning); facts come from
  that check, so `checkedAt` moves every minute and `filtering` is false only while a rebuild fails.
- **No restart policy:** game containers are created with restart policy `no` (like services); `Restore` drops an
  older agent's `unless-stopped` in place (`docker update`, no restart). After a reboot or a Docker restart nothing
  runs until the agent has rebuilt the table; `Restore` then starts the containers and autostart games, and the
  watcher starts a game container whose gss-init exited while the agent runs (backoff 10 s → 5 min; the game itself
  stays stopped/crashed as before). A plain agent restart leaves running containers alone.
- **Builds:** derived images (`packages:`) build on the agent's `gss-build` network (bridge `gss-build`, label
  `ionnet-gss.build`), which is always in the restricted set (key `build`), so `apt-get` reaches the public mirrors
  only. One named network is kept between builds (an idle bridge costs nothing); a build fails (409) while filtering
  doesn't work.
- **Fail closed:** when the table can't be applied, a restricted server's container and game don't start: the
  request gets a 409 with the cause and the agent re-sends the current state with it as `stateReason`. Allowed
  servers start anyway. When `Restore`'s rebuild fails (or a server's network can't be inspected), restricted servers
  are held back: a running container is stopped gracefully (with its services), a stopped one isn't started, and the
  state says why; the watcher starts them (and autostart games) once the rules apply. A broken table is retried every
  minute (`Firewall.Heal`). Host facts carry
  `egress { filtering, restricted, error, checkedAt }` (null before the first apply, or from an older agent); the
  panel validates it and shows it on the Host page with a warning when it doesn't work.
- **Limits:** one agent per table (a second agent's rebuild drops the first one's bridges; give it its own
  `egressTable`). An operator who flushes the whole ruleset (e.g. `systemctl restart nftables` with `flush ruleset`)
  removes this table: restricted servers run unfiltered until the next check (at most about a minute). A table that
  vanishes and then can't be rebuilt leaves already running servers running (facts and the Host page say so; new
  starts are refused). An operator's `docker start` of a game container is checked by the watcher right after, not
  before. Only private destinations are refused: a neighbour on a *public* address (another customer's VM in the same
  datacenter subnet, the host's own public IP) is reachable like any internet host, so a server can't be kept from
  probing it; and through the host's public IP a server reaches other servers' published ports (by design: that is
  how players reach them) but not the host's own services (`input` chain). Docker's embedded DNS (127.0.0.11) answers
  from the host namespace, so a server can resolve names through the host's private resolvers (only DNS answers, no
  connections). Other IPv6 translation prefixes (local-use NAT64 `64:ff9b:1::/48`, an operator's own NAT64 prefix)
  are not covered. Hosts need nf_tables with `nft_ct`, `nft_reject_inet` and set support (stock Debian/Ubuntu/Arch
  kernels).

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
- **Pinning and upgrade.** A server keeps its `definitionId` (one version; the built-in source's rows are updated in
  place, commit `"local"`). `updateAvailable` + `latestDefinition` on the detail; `POST /api/servers/:id/upgrade`
  while stopped re-resolves the variables (kept values, then `UpgradeServerBody.variables` over them; a value the new
  version rejects → 400 naming it as `"Label" (key)`, and the client's "Apply update" asks for just those) and
  re-provisions (`reinstall` when the install steps or a `reinstall` variable changed). Dropped ports are freed only
  after the agent took the new spec; on failure the old spec is provisioned again (best effort) and the upgrade's new
  ports freed; if that also fails both sets stay held until `start` (which re-provisions when the agent's last
  `specHash` differs from the row's) or the hello's reconcile settles it.
- **Per-server lock** (`GameServerService.withLock`, a keyed promise chain): create's provision, update, upgrade,
  start, restart, reinstall, updateGame, delete (and its retry) and each reconcile take turns per server. `stop` doesn't
  wait for it, so it can still cancel a long stack start or an install (the agent orders requests per server itself).
- **Patterns** (`pattern`, `options_from.include`) run on JS's backtracking engine, so validation refuses a repeated
  group that contains a quantifier or `|`, more than 3 unbounded quantifiers, look-around and back references, and
  patterns over 200 characters; a value over 1024 characters never matches (checked before any match). Worst case left:
  about 100 ms for 1024 characters with 3 unbounded quantifiers. The sound fix is V8's linear engine
  (`--enable-experimental-regexp-engine`, flag `l`), not enabled yet.
- **Image fields** (`image`, `services.*.image`) may only template a select variable with static `options`;
  `options_from` selects count as user text for shell quoting (`|sh` required).
- **`options_from`** (decided: panel-side fetcher, no hooks). `OptionsSource {url, items, value, where, include,
  reverse, limit}`; https host on OPTIONS_FETCH_HOSTS; ≤ 2 MiB; 10 s; cached OPTIONS_CACHE_MIN; static `options`
  first; on fetch failure the value must match the variable's new `pattern`. Route
  `GET /api/definitions/:id/options/:key`. Replaces the blueprint's `options_from: { hook }`.
- **Dependent lists and `when`.** `{{vars.<key>}}` (no filters) in an `options_from` `url` (after the host, URL-encoded),
  `where` values and `include` (regex-escaped) makes the list depend on other variables: `OptionsFetcher.render`
  fills them before the fetch. The options route takes the values from the query (`?version=1.21.4`, missing →
  default); `OptionsFetcher.dependencyValues` refuses a value its own variable wouldn't accept (static option, own
  list, `pattern`, type), and `.`/`..`, so callers can't make the panel fetch or cache arbitrary combinations.
  Responses are cached per URL (≤ 32) and lists per rendered source (≤ 500), so only a templated `url` fetches per value.
  `OptionsFetcher.checkValues` (create, settings, upgrade) re-checks a list when it, a dependency or a `when` key
  changes. `when: { flavour: [forge] }` shows a variable only for those values (`whenHolds` in `shared/variables.ts`,
  with `optionsDependencies`, used by both sides); a hidden select isn't checked against its list, but a value sent for
  it must be a static option or match its `pattern`. Validation refuses unknown, self, secret and circular references.
  Client: `useVariableOptions(id, variables, values)` refetches a dependent list 300 ms after its dependencies change,
  skips hidden ones, accepts static options while a list is down, and `VariableForm` moves a value the new list dropped
  (or a stored value of a list that was hidden at the start) to its first choice. `ServerVariableDto` carries
  `optionsDependOn` and `when`.
- **steamcmd** (gss-init): per-server copy in `INIT_STEAMCMD_DIR` (`/data/.gss/steamcmd`; no per-host cache),
  fetched from `STEAMCMD_URL`, anonymous login only, `+force_install_dir <dir>` (below /data), `+app_update <app>
  [-beta b] [validate]`, up to `STEAMCMD_ATTEMPTS` (3) tries, progress lines to the console, install progress per
  step. `server.update` (panel → agent) and supervisor `update` re-run only the steamcmd steps + the `update` hook
  while stopped or crashed, and from `install_failed` when the game was installed before (retrying a failed update;
  panel: `installedAt`, detail `installed`) (`POST /api/servers/:id/update`).
- **Config formats** (gss-init `configs/`): addressing per `ConfigFormat` (properties/cfg literal keys; ini
  `section.key`; json/yaml dotted paths). cfg = Source-engine `key "value"` lines (quotes escaped, comments kept).
  yaml uses `gopkg.in/yaml.v3` (in go.mod) node editing to keep comments. Only managed keys change; a missing file is
  created.
- **`packages:`** → `images.Resolver.Ensure`: generated Dockerfile only, names re-validated (`images.PackageName`, ≤
  50), cached as `ionnet-gss-derived:<hash16>`; build lines go to the console with `seq: 0`.
- **`services:`** → `stacks.Stack`: ≤ 4, containers `gss-<id>-<name>` on the server's bridge with alias `<name>`,
  never published, same hardening, `ServiceSpec.limits` (panel always fills them; they count toward quota usage),
  volume at `<server>/services/<name>` (delete with `keepData` keeps `services/` as well as `data/` and `backups/`),
  healthcheck wait before the game starts. Status travels in
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
| POST | /api/servers/:id/update | O | | `GameServerDto`; 409 running / never installed, 400 nothing to update |

`DefinitionDto` gains `sourceKind`, `isStack` and `services`; `ServerVariableDto` gains `optionsFrom` and `pattern`
(the settings form loads an `options_from` list from `GET /api/definitions/<server.definition.id>/options/<key>`);
`GameServerDetailResponse` gains `latestDefinition`, `source`, `services`, `canUpdateGame` and `installed`;
`UpgradeServerBody` gains `variables`. Client route `/sources` (nav: Manage → Sources).

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

### Host notes (M3)

- The agent's data root must be on a disk-backed filesystem: files written to tmpfs/ramfs are charged to the writing
  container's memory cgroup, so a steamcmd install is OOM-killed at the game's memory limit. `gss-agent run` warns.
- **Ports taken by other software:** host facts carry `boundPorts {tcp, udp}` (listening TCP and unconnected UDP
  sockets in the host namespace, from `/proc/net/{tcp,udp}{,6}`, ≤ 4096 each) and `PortAllocation.allocate` skips
  them (a pinned port that is bound gets a 409). A port taken between two heartbeats makes Docker's bind fail: the
  agent answers `port_in_use {proto, port}` (`ErrorBody.port`) and create and upgrade allocate around it once (pinned
  ports aren't moved). A start of an existing server whose port was taken since still fails with the bind error.
- **Console duplicates (Garry's Mod):** srcds itself prints every warning twice on a terminal, first in red
  (`ESC[38;2;255;90;90m`) and then again in the default colour (`ESC[39m`), e.g. "No account token specified…" and
  "Server ranking in server browser will be negatively impacted…". Seen in a raw `script` PTY capture of srcds_run
  outside gss; the pipeline forwards each line once.
- Garry's Mod (`games/garrys-mod`) needs no `packages`: srcds is 32-bit and the base image's lib32 runtime is enough.

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

## M4: operations

### Contracts

- **Access levels** (`servers/ServerAccess.ts`, implemented): owner and SERVERS_MANAGE_ALL hold `manage`; others the
  role of their `ServerShare` (view < operate < manage); below the level asked → 404. Files and backups: `manage`;
  metrics: `view`. `GameServerService.getAccessible` stays owner/MANAGE_ALL until the sharing UI moves it onto this.
  Live topic `server:<id>` still uses `canAccess` (owner/MANAGE_ALL).
- **Agent calls** from the M4 services go through `servers/agentCall.ts` (implemented): bad_request 400, forbidden 403,
  not_found 404, conflict 409, too_large 413, no_space 507, timeout 504, dropped 503, unsupported 501, else 502.
  `ErrorCode` gained `too_large` and `no_space` (`envelope.json`).
- **File manager** (`files.json`). The agent opens `<server>/data` as an `os.Root` (`internal/files`): every path is
  walked beneath the root's fd, so `..`, absolute paths and symlinks that lead out are refused (`bad_request`);
  in-folder symlinks are followed, listed as `symlink` with `linkTarget`, deleted as links. Root agent → new files
  are `Lchown`ed to GAME_UID. Writes are temp-file + fsync + rename, keep the mode, and check `expectedModifiedAt`
  (409). Editor cap FILE_TEXT_MAX_BYTES (2 MiB), content base64 on the agent channel (bounded frame size), plain
  UTF-8 to the browser; the save is `PUT …/files/content` with a `text/plain` body (its own body limit in `App.ts`).
  Files can change while the game runs; refused (409) only while a restore swaps the folder.
- **Transfers** (pull-based, no panel buffering). `transfer.open` → per chunk `transfer.read {offset, length}` /
  `transfer.write {offset, data}` (≤ TRANSFER_CHUNK_BYTES = 512 KiB, base64), at most TRANSFER_WINDOW = 4 in flight per
  transfer, which is the backpressure (the browser's read rate drives `pull()`, the agent's answers drive the upload
  body reads) → `transfer.commit` (upload: ranges must cover [0, size) exactly, rename from `UPLOAD_TEMP_DIR`
  = `.gss/uploads/<transferId>` inside the same root) / `transfer.close`. Responses bypass `AgentConnection`'s event
  queue, so chunks never wait behind console batches. Downloads: `POST …/download` → `DownloadTickets` (32 random
  bytes, single use, 60 s, in memory) → `GET /api/downloads/:ticket` (public; `Content-Length`,
  `application/octet-stream`, `attachment`, `nosniff`). Uploads: `PUT …/files/upload?path=` raw body, Content-Length
  required, ≤ UPLOAD_MAX_MB (no JSON body limit), XHR on the client for progress. Limits: TRANSFERS_PER_USER (429),
  TRANSFER_MAX_OPEN per agent (409), free disk ≥ size + UPLOAD_DISK_RESERVE_BYTES and the server's `diskMb` soft limit
  (507). Agent side closes a transfer after TRANSFER_IDLE_SEC idle, on `CloseServer` (restore) and `CloseAll` (each new
  panel connection); closing an upload deletes its temp file; agent startup empties `.gss/uploads`.
- **Backups** (`backup.json`). Archive `<server>/backups/<id>.tar.zst` (tar + zstd via `klauspost/compress`, pure Go,
  added to go.mod) + sidecar `<id>.json` (`BackupSidecar`: bytes, files, size). Entries: `gss-backup.json`
  (`BackupManifest`), `data/…`, `services/<name>/…`. Excludes (`backup.exclude`) apply to data/ only, anchored,
  `*`/`?` per segment, trailing `/` = folder. Running game: `before` commands, BACKUP_SETTLE_SEC (5 s), data/, `after`
  commands (also on failure). **Running service containers are paused** (`docker pause`) while their volume is
  archived: a crash-consistent point-in-time copy that InnoDB/Postgres recover from like a power cut; the game's
  queries stall for that time. Rows: `pending` → `running` (agent accepted) → `done`/`failed`; a refused create
  deletes its row. **No migration**: `backups` already has every column (`file` = `backups/<id>.tar.zst`).
- **Restore**: game stopped/crashed/install_failed only; backup `done`. Agent: close the server's transfers, extract
  into `<server>/restore-<id>/` (os.Root per root, no `..`/absolute/hard links/devices, setuid bits dropped, uid/gid
  kept only as root), stop services + game container, journal `<server>/restore.json`, swap by rename (same
  filesystem), start the game container again (gss-init re-reads the restored install marker; game stays stopped),
  delete the old folders. The container must restart because gss-init (PID 1) keeps running while the game is
  stopped and its `/data` bind mount pins the old inode. Interrupted swap → agent startup rolls back from the journal.
- **One operation per server** (`ServerStatus.operation`, also in hello). While set, provision/start/restart/update/
  reinstall answer 409; stop is allowed during a backup; delete cancels a backup and is refused during a restore.
- **Backup limit seam**: `BackupService.assertSlot` counts the server's non-failed backups against the owner's
  `maxBackups` (DEFAULT_QUOTA_BACKUPS when null; admins pass); M5 replaces it with the user-wide `Quota.assertFits`.
  Backups don't count toward the server's `diskMb` (they aren't in data/); total disk quota is M5.
- **Metrics**: agent `statsLoop` every STATS_INTERVAL_SEC (5 s) for games starting/running; stacks **summed** (CPU,
  memory, pids, and memory *limits* summed too, so used/limit stays meaningful), network from the game container only
  (game↔db traffic would count twice), `diskBytes` every STATS_DISK_INTERVAL_SEC (60 s) from the disk check's
  measurement. Panel `MetricRing` (720 samples ≈ 1 h, rates from cumulative counters, decrease = restart),
  in memory only; `server.stats` live on `server:<id>`; history from `GET …/metrics`.
- **Players**: gss-init `initd/players.go` matches `players.join/leave` (RE2, ANSI stripped, first group = name,
  ≤ PLAYER_NAME_MAX_CHARS, ≤ PLAYERS_MAX), emits `player` events, keeps the list in `InitStatus.players`, resets it when
  the game exits (no leave events). Agent: `server.players` in `ServerStatus.players` (hello reseeds the panel after a
  panel restart). Panel: `MetricsService` list, `server.players` (whole list) on `server:<id>`; cleared when the state
  leaves starting/running. Definition validation refuses `players` patterns without a capture group.
- **Live (M4)**: `server.stats { serverId, sample, diskBytes }` and `server.players`, `backup.progress` (topic
  `server:<id>`), `backup.updated { serverId, backupId }` (owner + SERVERS_MANAGE_ALL).
- **Hot paths are no-ops until built**: `MetricsService.{recordStats, applyPlayer, onStateChange, seedFromHello}` and
  `BackupService.{applyProgress, applyFinished, reconcile}` are wired into the handlers/hello now and do nothing, so
  the dev instance (watch mode) keeps working; new routes answer 501.

### API routes (M4)

Access: `M` = manage level, `V` = view level (else 404).

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/servers/:id/files?path= | M | | `FileListResponse` |
| GET | /api/servers/:id/files/content?path= | M | | `FileContentResponse`; 413, 415 not text |
| PUT | /api/servers/:id/files/content?path=&modifiedAt= | M | text/plain ≤ 2 MiB | `FileEntryDto`; 409 changed |
| POST | /api/servers/:id/files/folder | M | `CreateFolderBody` | 201 `FileEntryDto`; 409 exists |
| POST | /api/servers/:id/files/rename | M | `RenameFileBody` | `FileEntryDto`; 409 exists |
| POST | /api/servers/:id/files/delete | M | `DeleteFilesBody` | `OkResponse` |
| PUT | /api/servers/:id/files/upload?path=&overwrite= | M | raw, Content-Length | 201 `FileEntryDto`; 409, 411, 413, 429, 507 |
| POST | /api/servers/:id/files/download | M | `DownloadFileBody` | `DownloadTicketResponse`; 409 folder |
| GET | /api/downloads/:ticket | ticket | | file stream; 404 unknown/expired |
| GET | /api/servers/:id/backups | M | | `BackupListResponse` |
| POST | /api/servers/:id/backups | M | `CreateBackupBody` | 202 `BackupDto`; 409 busy/state/limit/offline, 507 |
| DELETE | /api/servers/:id/backups/:backupId | M | | `OkResponse`; 409 running |
| POST | /api/servers/:id/backups/:backupId/restore | M | | 202 `RestoreBackupResponse`; 409 not stopped / not done / busy, 507 |
| POST | /api/servers/:id/backups/:backupId/download | M | | `DownloadTicketResponse`; 409 not done |
| GET | /api/servers/:id/metrics | V | | `ServerMetricsResponse` |

Client: ServerDetail tabs Overview (`MetricsPanel` + `PlayerList`, default), Console, Files (`FileManager`), Backups
(`BackupList`), Settings.

### Failure cases (M4)

| Case | What happens |
| --- | --- |
| Path escape (`..`, absolute, symlink out) | `os.Root` refuses it at the walk → `bad_request` → 400 "The path leaves the server's folder."; nothing is opened |
| Symlink swapped by the game mid-operation | each step resolves beneath the root's fd, so a swap can only redirect inside the data folder |
| Browser aborts a download | stream `cancel()` → `transfer.close`; agent closes the fd |
| Browser aborts an upload / body shorter than Content-Length | request signal aborts → `transfer.close` → temp file deleted; 400 for a short body |
| Panel restarts mid-transfer | agent drops it after TRANSFER_IDLE_SEC (temp deleted) |
| Agent disconnects mid-transfer | pending requests reject → download truncated (Content-Length tells the browser), upload 503; new connection → `CloseAll` |
| Agent disconnects during backup/restore | operation continues detached; progress dropped, `backup.finished` kept in the outbox; hello carries `ServerStatus.operation` |
| Agent restarts during a backup | `.partial` removed at startup; hello has no operation → panel marks the row failed ("The host's agent restarted while the backup ran.") |
| Agent dies during a restore swap | startup reads `restore.json` and rolls back to the old folders; the row stays `done`, the restore is reported failed |
| Disk full (backup, upload, restore) | checked before start (free ≥ estimate + 1 GiB → else 507); ENOSPC midway → partial/temp/extract removed, `no_space` / finished with error; live data untouched |
| Restore while running / installing | 409 "Stop the server first." (panel state check; agent checks again) |
| Start while a restore runs | agent 409 "A restore of this server is running…" |
| Backup of a server mid-install / creating / deleting | 409 "Wait until the install finishes." |
| Second backup while one runs | 409 (panel `_operations`, agent `s.operation`) |
| Backup limit reached | 409 naming the limit; delete an old backup first (no automatic rotation in v1) |
| Pause of a service container fails | backup fails (no inconsistent DB copy), containers unpaused |
| Archive written but `backup.finished` lost (agent crash right after) | row failed; delete of a failed row still deletes the file on the host |
| Text file changed since it was opened | 409; the editor offers reload or overwrite |

### Boundaries added in M4

| From | May import | Never |
| --- | --- | --- |
| `servers/{File,Backup,Metrics}Service.ts` | `ServerAccess`, `agentCall`, `transfers/*`, `LiveGateway`, models, `@shared` | Hono `Context`, `AgentGateway` directly (use `agentCall`) |
| `transfers/*` | `agentCall`, `@shared` | models, controllers (callers check access) |
| `controllers/{File,Backup,Metrics,Download}Controller.ts` | their service, `transfers/DownloadTickets` + `TransferRelay` (Download only), lib | `agentCall`, models beyond `AuditLog`/`User` |
| `agent/internal/files` | stdlib, `protocol` | `servers`, `docker`, `panel` |
| `agent/internal/backups` | stdlib, `klauspost/compress/zstd`, `protocol` | `servers`, `docker`, `panel` |
| `agent/internal/servers` (M4 files) | `files`, `backups` | `panel`; reports through `Sink` |
| `agent/internal/agent/files.go` | `servers.Manager`, `files.Transfers`, `protocol` | `os` paths directly (always through `files.FS`) |

### Extension points (M4)

- `TransferSource` + `TransferRelay.DownloadSource`: new downloadable kinds (e.g. a folder as tar later).
- `BackupService.assertSlot`: the quota seam (M5). Schedules (later) call `BackupService.create` with `createdById`
  null.
- `ServerAccess.Level`: sharing UI (M5) only adds rows to `server_shares`.
- `ServerStats` per-service breakdown: add a `services` list to the schema; the summed fields stay.

### Open hardening (not in M4)

From the M4 review; none of these loses data or crosses tenants.

- Transfer slots: TRANSFER_MAX_OPEN is per host (16) and TRANSFERS_PER_USER is 4, so four users can hold every slot on
  a host, and a slow reader never goes idle. Add a per-server cap on the agent. `DownloadTickets.issue` has no
  per-user limit (entries expire after 60 s).
- `files.List` reads and sorts a whole folder before cutting to the listing limit; a folder with a million entries
  costs agent memory. Read in batches.
- Timeouts: the agent allows file operations 120 s, the panel waits 30 s, so a huge list/delete can answer 504 while it
  still finishes on the host.
- `CommitUpload` and rename without overwrite check then rename; a file created in between is replaced. Needs
  `renameat2(RENAME_NOREPLACE)`. An upload over a symlink replaces the link, `WriteText` writes its target: pick one.
- `servers/files.go`: the restore check and `OpenRoot` aren't atomic; a request in that window works on the old folder.
- Client: a failed ticket download shows as a failed browser download instead of the panel's message; the Files tab
  lists the internal `.gss` folder.
- Stack backups need the agent to read service volumes (root agent); untested end to end with `garrys-mod-mysql`.
- Minecraft player patterns accept the server's own `System chat:` prefix, so a plugin broadcast reading
  "X joined the game" counts as a join. Chat and `say` can't.

## M4 work split

Main-session-only files (as before, plus; all M4 contracts are already in them): `protocol/schema/*` + generated,
`shared/api/{files,backups,metrics}.ts`, `shared/live.ts`, `shared/constants.ts`, `shared/index.ts`,
`server/src/{App,Config}.ts`, `.env.example`, compose files, `ApiController.ts`, `gateways/agent/handlers/{index,hello,
serverState}.ts`, `gateways/agent/AgentConnection.ts`, `models/User.ts`, `servers/{ServerAccess,agentCall}.ts`,
`agent/go.mod`/`go.sum`, `agent/internal/docker/**` (Pause/Unpause done), `agent/internal/paths/**`,
`agent/internal/servers/{manager,new,server}.go` (fields and `Status()` done; parcel C may edit `server.go`'s watcher
for players only), `agent/internal/agent/agent.go`, `client/src/Api/BaseApi.ts` (A fills `PUT_TEXT`/`UPLOAD`, nothing
else), `client/src/pages/ServerDetail/ServerDetail.tsx` (tabs done). Need a change there? Report it back.

| Parcel | Difficulty / route | Owns | Contract | Verify on its own |
| --- | --- | --- | --- | --- |
| **A: files + transfers (agent + panel)** | **Hard** (confinement, concurrency, streaming backpressure): `builder-opus` | `agent/internal/files/**` (+ tests), `agent/internal/agent/files.go`, `agent/internal/servers/files.go`, `server/src/transfers/**`, `server/src/servers/FileService.ts`, `server/src/controllers/{File,Download}Controller.ts`, `BaseApi.PUT_TEXT`/`UPLOAD` bodies | `files.json`, `shared/api/files.ts`, `TransferRelay`/`DownloadTickets` signatures | `go test ./internal/files/...`: table tests with planted symlinks (absolute, `../..`, chained, swapped between calls), `..`, NUL, rename into itself, overwrite rules, ENOSPC via a small tmpfs is optional. Panel on a private port (`PORT=3301 DB_NAME=gss_b`, migrate), a second agent enrolled to it with its own `--config`, data root and `egressTable` (never the dev agent), a hand-provisioned scratch server or a fake server folder: curl list/read/write (409 on stale modifiedAt)/mkdir/rename/delete; upload a 1 GiB file (`curl -T`), watch panel RSS stay flat (`ps -o rss`), kill curl midway → temp gone; download via ticket (`curl -OJ`), `cmp` with the source; second use of a ticket → 404; kill the scratch agent mid-download → truncated + agent restart clears `.gss/uploads` |
| **B: backups + restore (agent + panel)** | **Hard** (data-loss paths, lifecycle interplay, crash recovery): `builder-opus` | `agent/internal/backups/**` (+ tests), `agent/internal/servers/backup.go`, the `checkIdleLocked` calls in `servers/{lifecycle,provision}.go`, startup cleanup + journal rollback in `servers/restore.go`, `server/src/servers/BackupService.ts`, `server/src/controllers/BackupController.ts`, `gateways/agent/handlers/backup{Progress,Finished}.ts` | `backup.json`, `shared/api/backups.ts`, `Manager.{Create,Restore,Delete}Backup`/`BackupArchive`, `Sink.Backup*`, `TransferRelay.openDownload` (A) for downloads | `go test ./internal/backups/...`: round trip with excludes, symlinks, modes; hostile archives (`../x`, absolute, symlink-then-file, hard link, device) refused. Private panel `PORT=3302 DB_NAME=gss_c` + own scratch agent: Minecraft server → backup while running (console shows save-off/save-all/save-on), backup of `garrys-mod-mysql` (db paused then resumed, `docker inspect` State.Paused false after), restore while running → 409, stop → restore → world back, `kill -9` the agent between the renames (env hook or debugger) → restart rolls back; limit 409 at `DEFAULT_QUOTA_BACKUPS`; download via a ticket once A lands (else `transfer.open` by hand) |
| **C: metrics + players (agent, gss-init, panel, client)** | Medium: `builder` | `agent/internal/servers/stats.go`, players in `servers/server.go`'s watcher, `agent/internal/initd/players.go` + its wiring in `initd/initd.go` (onGameOutput, exit, statusLocked), `players` validation in `server/src/definitions/DefinitionEngine.ts` (capture group), `server/src/servers/{MetricsService,MetricRing}.ts`, `server/src/controllers/MetricsController.ts`, `gateways/agent/handlers/server{Stats,Player}.ts`, `client/src/Api/MetricsApi.ts`, `client/src/components/{MetricsPanel,PlayerList}/**` | `server.json` (`ServerStats`, `PlayerEvent`, `ServerStatus.players`), `supervisor.json` (`InitStatus.players`), `shared/api/metrics.ts`, live `server.stats`/`server.players` | `go test ./internal/initd/...` (players: join/leave/dup/limit/reset, ANSI lines); private panel `PORT=3303 DB_NAME=gss_d` + own scratch agent: a running Minecraft server → `/ws/live` subscriber gets `server.stats` every 5 s with rates, `diskBytes` once a minute; join with a client (or `say`-free: feed matching lines through a scratch gss-init spec) → `server.players`; stop → list empties; restart the panel → hello reseeds players. Client: `npm run typecheck && npm run build`, headless Playwright with mocked `/metrics` and socket, screenshots light + dark |
| **D: client Files + Backups tabs** | Medium: `builder` | `client/src/components/{FileManager,BackupList}/**`, `client/src/Api/{File,Backup}Api.ts` | `shared/api/{files,backups}.ts`, live `backup.updated`/`backup.progress`, `BaseApi.PUT_TEXT`/`UPLOAD` (stub-reject until A; mock in tests) | `npm run typecheck && npm run build`; headless Playwright against `deno task dev` with `page.route("/api/servers/*/files*")` / `/backups*` mocks and a mocked socket: breadcrumb navigation, open/edit/save (409 dialog), upload with progress and cancel, overwrite prompt, rename, delete confirm, new folder, download (ticket → `<a download>`); backups list, create, progress bar from `backup.progress`, restore disabled while running, delete confirm. Screenshots light + dark, phone width |

Order: all four in parallel. A ↔ B meet at `transfer.open` with `source: "backup"` (`Manager.BackupArchive`) and at
`Options.Transfers.CloseServer` (restore); A ↔ D and B ↔ D at `shared/api/*` (D mocks until they land); C stands alone.
Builders never stop the dev instance (:3200/:5200) or its agent, never `pkill` by pattern, and use their own port,
scratch DB, agent config, data root and `egressTable`. Integration (main): real Minecraft world restore from the UI on
this machine, a 1 GiB upload and download through the UI, charts and players live while someone joins.

## M5: tenancy

### Contracts

- **No protocol change.** Quotas, grants, sharing and TOTP are panel-only; the install script drives the existing
  `gss-agent enrol` (`--token-stdin`) and `run`. `protocol/schema/*` and the generated files stay as they are.
- **Migration** `20261120000000-m5-tenancy.ts`: `users.totp_last_step` (INTEGER, null; the last accepted TOTP time
  step, replay guard) and table `recovery_codes` (`user_id` FK cascade, `code_hash` CHAR(64) SHA-256, `used_at`,
  timestamps; index `user_id`). `quotas`, `host_grants` and `server_shares` exist since v1.
- **Quotas** (`models/Quota.ts`). Effective limit per field = the user's row value, else `Config.DEFAULT_QUOTA_*`
  (null = inherit). Admins are `exempt` (usage still reported). Usage, over the owner's servers whose state isn't
  `deleting`: `servers` = count; `memoryMb`/`cpuMillis` = Σ game limits + Σ service limits
  (`DefinitionEngine.serviceTotals(definition.document)`, the same sum host capacity uses); `diskMb` = Σ `diskMb`
  (the soft limit, not measured bytes); `backups` = backups not `failed` on those servers. Usage is charged to the
  server's **owner**, whoever makes the change (shared managers, SERVERS_MANAGE_ALL).
  - `Quota.assertFits(userId, delta, transaction)`: first statement locks the user's row (`SELECT … FOR UPDATE` on
    `users`), then sums usage inside the transaction, then refuses (409) when `used + delta > limit` for any field
    in `delta`. Only growth is checked: lowering a quota below current usage is allowed and only blocks further growth.
    Lock order is always **user → host** (create locks the host row after `assertFits`).
  - Callers make the check and the write that makes the usage visible in the same transaction: create (row insert),
    update/upgrade (write the new limits before provisioning, put the old ones back if provisioning fails), backup
    create (row insert `pending`). Host capacity on update/upgrade takes the host row lock in that transaction too
    (today only create does).
  - Messages name the field, the would-be total and the limit: "This would use 6144 MB of RAM; your quota is 4096
    MB." / "You already have 2 game servers, the most your quota allows (2)." / "Your servers already have 5 backups,
    the most your quota allows (5). Delete an old one first." When the caller isn't the owner: "…; the owner's quota
    is …".
  - `BackupService.assertSlot` (per server) is replaced by `Quota.assertFits(server.ownerId, { backups: 1 }, t)`;
    `BackupListResponse.limit` becomes the owner's user-wide `{ max, used }` (max null = exempt).
  - Editing: USERS_MANAGE; a non-admin may not edit an admin's quota or **their own** (403), else USERS_MANAGE would
    let them raise their own limits. Each field: whole number 0 … 2^31-1 or null; absent = unchanged. Audit
    `user.quota_changed`; live `quota.updated`.
- **Host grants** (`models/HostGrant.ts`). A grant lets a user with SERVERS_CREATE create servers on that host and
  see it (list, detail). SERVERS_MANAGE_ALL (and admins) need none. Create already refuses an ungranted host (403,
  `mayUseHost`); M5 adds the routes and the list rules: `GET /api/hosts` = every host for HOSTS_MANAGE or
  SERVERS_MANAGE_ALL, else the granted ones for HOSTS_VIEW or SERVERS_CREATE. `HostDto.canCreate` = SERVERS_CREATE
  and (SERVERS_MANAGE_ALL or granted); the create page's picker shows only `canCreate` hosts. Grants are by username
  (HOSTS_MANAGE may lack USERS_MANAGE, so there's no user list to pick from). Revoking keeps the user's existing
  servers on that host running and operable; only new creates are refused. Audit `host.granted`/`host.revoked`;
  `host.updated` to HOSTS_MANAGE + granted users + the user just revoked.
- **Sharing** (`servers/ShareService.ts`, `servers/ServerAccess.ts`). Levels `view < operate < manage < owner`;
  `owner` = the owner or SERVERS_MANAGE_ALL (never stored), the others are `ServerShare.role`. Below the level asked
  → 404.

  | Level | Allows |
  | --- | --- |
  | view | list, detail, console backlog + live topic `server:<id>`, metrics, players |
  | operate | + start, stop, restart, console input |
  | manage | + settings (PATCH), upgrade, update game, reinstall, files, backups (create, restore, delete, download) |
  | owner | + delete the server, list/add/change/remove shares |

  Any shared user may remove their own share (leave) at `view`. Shares are by username; not with yourself or the
  owner (400); unknown user 404; existing share 409 (use PATCH); at most `LIMITS.SHARES_PER_SERVER` (20) per server.
  `GameServerDto.access` = the caller's level (the client hides and disables by it). `GameServerService.getAccessible
  (user, id, level)` now goes through `ServerAccess.get`; `list` uses `ServerAccess.scopeOf(user)` (owned + shared,
  or all); the live topic check uses `ServerAccess.levelOf` (≥ view).
  - **Live audiences** for `server.updated`, `server.state`, `server.services`, `backup.updated` are
    `ServerAccess.audience(serverId, ownerId)` = SERVERS_MANAGE_ALL + owner + every shared user. It is synchronous
    (pushes happen on the agent event path), backed by an in-memory index `serverId → userIds` that
    `ServerAccess.init()` loads at startup and `ShareService` updates on every add/remove (`rememberShare`,
    `forgetShare`, `forgetServer` on delete). One panel process, so the index can't drift from another writer.
  - Removing a share (or the server) calls `LiveGateway.dropTopic(userId, topic)` so the removed user stops
    receiving console/stats at once, and pushes `server.updated { serverId }` to them (their client refetches, gets
    404 and leaves the page). Changing a role pushes `server.updated` to that user.
  - Audit `server.shared`, `server.share_changed`, `server.unshared` (details: serverId, username, role).
- **TOTP** (`lib/totp.ts`, `models/User.ts` TOTP region, `models/RecoveryCode.ts`, `controllers/TotpController.ts`).
  RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, WebCrypto only (no dependency). Base32 secret, 20 random bytes.
  - Setup → secret stored with `totpEnabled` false (a pending setup is replaced by a new one); 409 when already
    enabled ("Turn two-factor sign-in off first."). Confirm (code) → `totpEnabled` true, `totpLastStep` = matched
    step, 10 recovery codes issued and returned once. Disable and new recovery codes need the password and a current
    code (or a recovery code).
  - **Login** with TOTP on: `/auth/login` answers `TwoFactorChallenge` (a `purpose: "totp"` JWT, 5 min, carries
    `ver`). `/auth/login/totp` verifies the challenge (`User.findByChallenge`: purpose `totp`, `ver` current, not
    disabled, `totpEnabled`), then the code: 6 digits → `verifyCode(secret, code, totpLastStep)` returns the matched
    step, accepted only if it is newer than `totpLastStep`, stored by a conditional update (`… WHERE totp_last_step IS
    NULL OR totp_last_step < :step`; 0 rows = replay → 401); otherwise a recovery code (`RecoveryCode.consume`:
    conditional `UPDATE … SET used_at WHERE code_hash = ? AND used_at IS NULL`, single-use under concurrency). Wrong
    codes count in the per-user failure limiter (same window as passwords, key `totp:<userId>`); 429 beyond. Audit
    `user.login` with `{ method: "totp" | "recovery_code" }`, `user.login_failed` with `{ stage: "totp" }`.
  - Recovery codes: `xxxxx-xxxxx` (10 lowercase base32 characters, 50 bits), compared after lowercasing and removing
    `-`/spaces, stored as SHA-256 (`lib/tokens.sha256Hex`). New codes replace every old one.
  - **Admin reset** `POST /api/users/:id/totp/reset` (USERS_MANAGE; non-admins can't reset an admin, 403): clears
    the secret, `totpEnabled` false, deletes the recovery codes, bumps `tokenVersion` (the user's sessions end).
    Audit `user.totp_reset`. Enabling or disabling 2FA yourself ends no sessions.
  - The secret is stored in plain base32 (needed to verify); see open hardening.
- **QR code**: rendered in the browser from `otpauthUrl` by `components/QrCode` with `qrcode-generator` (MIT, no
  dependencies, ~20 KB, lazy-loaded with the setup dialog). The secret is shown as text next to it for manual entry.
- **Agent install** (`scripts/install-agent.sh`, `controllers/AgentController.ts`). Public routes, rate-limited per
  IP (`RATE_LIMIT_PUBLIC_PER_IP`):
  - `GET /api/agent/install.sh`: the script with `@PANEL_URL@` replaced by `PUBLIC_URL` and `@INSECURE@` by `1` when
    `PUBLIC_URL` is plain http:// on a non-loopback host (same rule as `enrolCommand`), else `0`.
  - `GET /api/agent/download/:os/:arch` (`linux` / `amd64|arm64`): `AGENT_DIST_DIR/gss-agent-<os>-<arch>` (what
    `make dist` writes), `application/octet-stream`, `Content-Length`, `X-Gss-Version` (from `VERSION`), streamed.
    `…/sha256`: the hex digest from the `.sha256` sidecar, `text/plain`. Unknown os/arch 400; not built 404 "The
    panel has no agent build for linux/arm64. Run `make dist` in agent/ (the Docker image includes it)."
  - `EnrolTokenCreatedResponse.installCommand` = `curl -fsSL <PUBLIC_URL>/api/agent/install.sh | sudo
    bash`; neither it nor `command` (`… enrol --token-stdin`) contains the token. The script prompts `Enrol token:`
    on `/dev/tty` (`read -rs`), or takes `GSS_ENROL_TOKEN` from the environment; neither → exit 2. A token in sudo's
    argv would be readable in `ps` for the whole install (`command` stays for hosts that already have the binary). The enrol dialog shows the install one-liner first, the manual `command` below it.
  - Script: `install` (default) | `uninstall` | `help` | `version`; flags `--panel <url>`, `--insecure`,
    `--no-start`, `--dry-run` (prints each step instead of changing the system), `-y/--yes`. Steps: root check;
    `/etc/arch-release` → pacman, `/etc/debian_version` → apt, else exit 3; systemd present; Docker (`docker` /
    `docker.io`) installed, enabled and running; `nftables` package installed but **its service never enabled**
    (Debian's `/etc/nftables.conf` starts with `flush ruleset`, which would wipe Docker's and the agent's rules);
    `uname -m` → amd64/arm64; download to `/usr/local/bin/gss-agent.new`, verify against `…/sha256`, rename; enrol
    with `--token-stdin` unless `/etc/ionnet-gss/agent.json` exists (then it upgrades the binary and restarts); write
    `/etc/systemd/system/gss-agent.service` (same content as `agent/packaging/gss-agent.service`), `daemon-reload`,
    `enable --now`. Exit codes: 0, 1 failure, 2 bad arguments, 3 unsupported system. Uninstall stops and removes the
    unit and binary, keeps `/etc/ionnet-gss` and `/var/lib/ionnet-gss` unless `--purge` (asks `[y/N]`).
  - `Config.AGENT_DIST_DIR` (default `agent/dist`); the Docker image builds `make dist` in a Go stage and copies
    `agent/dist` and `scripts/`.
- **Live (M5)**: `quota.updated { userId }` (USERS_MANAGE + the user). Usage changes need no event: the account
  page's quota card also refetches on `server.updated` and `backup.updated`, which reach the owner.

### API routes (M5)

Access: `S` signed in, `P:<KEY>` permission, `O` = owner level, `V` = view level, `RL` rate-limited.

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/quota | S | | `EffectiveQuotaDto` (own) |
| GET | /api/users/:id/quota | P:USERS_MANAGE | | `EffectiveQuotaDto` |
| PUT | /api/users/:id/quota | P:USERS_MANAGE | `UpdateQuotaBody` | `EffectiveQuotaDto`; 400, 403 own/admin |
| GET | /api/hosts/:id/grants | P:HOSTS_MANAGE | | `HostGrantDto[]` |
| POST | /api/hosts/:id/grants | P:HOSTS_MANAGE | `CreateHostGrantBody` | 201 `HostGrantDto`; 404 user, 409 exists |
| DELETE | /api/hosts/:id/grants/:userId | P:HOSTS_MANAGE | | `OkResponse`; 404 |
| GET | /api/servers/:id/shares | O | | `ServerShareDto[]` |
| POST | /api/servers/:id/shares | O | `CreateShareBody` | 201 `ServerShareDto`; 400 self/owner, 404 user, 409 exists/limit |
| PATCH | /api/servers/:id/shares/:userId | O | `UpdateShareBody` | `ServerShareDto` |
| DELETE | /api/servers/:id/shares/:userId | O (V for yourself) | | `OkResponse` |
| POST | /api/auth/login/totp | -, RL | `TotpLoginBody` | `LoginSuccess`; 401, 429 |
| GET | /api/auth/totp | S | | `TotpStatusResponse` |
| POST | /api/auth/totp/setup | S | | `TotpSetupResponse`; 409 enabled |
| POST | /api/auth/totp/confirm | S | `TotpConfirmBody` | `TotpConfirmResponse`; 400 code, 409 no setup |
| POST | /api/auth/totp/disable | S | `TotpDisableBody` | `UserDto`; 401 password/code |
| POST | /api/auth/totp/recovery-codes | S | `RecoveryCodesBody` | `RecoveryCodesResponse`; 401 |
| POST | /api/users/:id/totp/reset | P:USERS_MANAGE | | `UserDto`; 403 admin target |
| GET | /api/agent/install.sh | -, RL | | `text/x-shellscript` |
| GET | /api/agent/download/:os/:arch[/sha256] | -, RL | | binary / hex digest; 400, 404 |

Changed shapes: `HostDto.canCreate`, `GameServerDto.access`, `EffectiveQuotaDto.exempt`,
`EnrolTokenCreatedResponse.installCommand`, `TotpConfirmResponse` (was `UserDto`). The M1 table's
`PUT /api/hosts/:id/grants/:userId` is now `POST /api/hosts/:id/grants` with a username. Client: no new pages; the
account page gains a quota card and a two-factor card, the users page a quota dialog and "Reset two-factor", the
host page a grants card, the server page a Sharing tab (owner level).

### Failure cases (M5)

| Case | What happens |
| --- | --- |
| Two creates by one user race for the last slot | both lock the user row in turn; the second sees the first's row → 409 |
| Update of server A and upgrade of server B (same owner) race for RAM | same user lock; new limits are written in that transaction, provisioning after; on failure the old limits are written back |
| Admin lowers a quota below usage | allowed; existing servers keep running; any growth (create, bigger limits, backup) → 409 |
| Shared manager raises RAM | charged to the owner's quota; message says "the owner's quota" |
| Share removed while the user watches the console | `dropTopic` stops the stream; `server.updated` → refetch → 404 → back to the list |
| Grant revoked | the host disappears from the user's picker (`host.updated`); their servers there keep running and stay operable |
| TOTP code replayed within its 90 s window | conditional update on `totp_last_step` matches 0 rows → 401 |
| Recovery code used twice at once | conditional update; one wins, the other 401 |
| Code guessing | per-user failure limiter → 429 + Retry-After; the challenge also expires after 5 min |
| Password changed / user disabled between password and code | challenge `ver` no longer matches / user disabled → 401 |
| User lost the phone and the codes | admin "Reset two-factor" (ends the user's sessions) |
| Install on Fedora / no systemd | exit 3 with "Only Arch Linux and Debian/Ubuntu with systemd are supported. …" |
| Binary not built on the panel | script stops at the download: 404 message printed, nothing installed |
| Checksum mismatch | `.new` file deleted, exit 1, nothing replaced |
| Script run again on an enrolled host | no enrol; binary upgraded, service restarted |

### Boundaries added in M5

| From | May import | Never |
| --- | --- | --- |
| `models/Quota.ts` | models, `Config`, `DefinitionEngine.serviceTotals` (pure) | `GameServerService`, controllers |
| `servers/ShareService.ts` | `ServerAccess`, models, `LiveGateway`, `@shared` | Hono `Context` |
| `servers/ServerAccess.ts` | models, `@shared` | `LiveGateway` sockets (it only builds `Audience` values) |
| `controllers/{Quota,Totp,Share,Agent}Controller.ts` | their model/service, lib, `Config` | `AgentGateway` |
| `controllers/AgentController.ts` | `Deno.open` on `AGENT_DIST_DIR` files named by the fixed pattern, `scripts/install-agent.sh` | any path built from request input |
| `scripts/install-agent.sh` | `curl`, the panel's `/api/agent/*`, `gss-agent enrol/run` | the token in argv (env → `--token-stdin` only) |
| `client/src/components/QrCode` | `qrcode-generator` (lazy import) | other components (they use `QrCode`) |

### Extension points (M5)

- `Quota.Delta` + `EffectiveQuotaDto`: a new limit = a `quotas` column (migration), a `DEFAULT_QUOTA_*` setting, a
  usage sum in `Quota.getUsage`, a field in `Delta`, a row in the quota card.
- `ServerAccess.Level` + the level table above: a new server operation picks a level at its `getAccessible` call.
- `TotpController`: other second factors (WebAuthn later) add a method next to `totp` in the challenge flow.
- `install-agent.sh` `pkg_install` / `detect_distro`: another distro = one more branch.

### Open hardening

Carried from M4 (none fits an M5 parcel's files; all stay open): transfer slot fairness (per-server cap on the
agent, per-user `DownloadTickets` cap) is the one that matters most now that several tenants share a host and is the
first candidate for a hardening parcel after M5; `files.List` batching; agent/panel file timeouts;
`RENAME_NOREPLACE`; restore/OpenRoot atomicity; client ticket errors and the `.gss` folder; stack backups end to end;
Minecraft `System chat:` joins.

New in M5:

- TOTP secrets are stored in plain base32; encrypting them with a key outside the DB (e.g. derived from a separate
  `TOTP_KEY`) would protect them against a database-only leak.
- Disk quota counts the servers' soft `diskMb` limits, not measured bytes (backups aren't in it); measured usage
  is in `server.stats.diskBytes` if a hard check is wanted later.
- The usage sum loads the owner's servers with their definition documents on every check; fine for a handful of
  servers per user, cache the service totals on the row if that grows.
- The second-factor lockout (`totp:<userId>`, 10 failures per 15 minutes) is a fixed in-memory window: it resets
  on a panel restart and doesn't grow, so someone who already has the password gets about 960 guesses a day. Make
  it grow across windows or store it in the DB, and notify the user on repeated `stage: "totp"` failures.
- The agent download's checksum comes from the same origin as the binary: it catches truncation, not tampering.
  Over plain http the install is only safe on a trusted network (the dialog and script say so); signed releases
  would close it.
- Wrong codes at `/auth/totp/confirm` aren't rate-limited (the caller is signed in and made the secret), and a
  challenge token can be reused within its 5 minutes (each use needs a fresh code and counts toward the lockout).
- Console input validates its body before the access check, so a user without access gets 400 instead of 404 on
  a bad body (leaks nothing: any id answers 400).

## M5 work split

Main-session-only files (as before, plus; all M5 contracts are already in them): `shared/api/*`, `shared/live.ts`,
`shared/constants.ts`, `shared/index.ts`, `server/src/{index,Config}.ts`, `.env.example`, `Dockerfile` +
`.dockerignore` (Go stage runs `make dist`), compose files, `migrations/*`, `models/index.ts`, `ApiController.ts`, `definitions/DefinitionEngine.ts`
(`serviceTotals` moved there), `client/package.json` + lock (`qrcode-generator` added), every `client/src/Api/*.ts`
(all M5 wrappers written), `client/src/components/QrCode/**`, `client/src/routes.tsx`, `AppLayout.tsx`. The access
wiring in `GameServerService` and `BackupService` (levels at every `getAccessible`, `ServerAccess.audience`,
`scopeOf` in `list`, `access` in `toDto`) is done; parcel A may edit only the quota regions marked `TODO(builder):
M5 quota`. Need a change elsewhere? Report it back.

| Parcel | Difficulty / route | Owns | Contract | Verify on its own |
| --- | --- | --- | --- | --- |
| **A: quotas** | **Hard** (accounting under concurrency, lock order, rollback of reserved limits): `builder-opus` | `models/Quota.ts`, `controllers/QuotaController.ts`, the quota region of `controllers/UserController.ts`, the `TODO(builder): M5 quota` regions of `servers/GameServerService.ts` (create, updateLocked, upgradeLocked + host lock there), `assertSlot`/`slot` + the create path's slot check in `servers/BackupService.ts`, `client/src/components/{QuotaUsage,QuotaDialog}/**`, `client/src/pages/Users/**` (quota dialog + "Reset two-factor" action calling `UserApi.resetTotp`) | `Quota.Delta`, `assertFits(userId, delta, t)`, `getUsage`, `getEffective`, `EffectiveQuotaDto`, live `quota.updated` | `deno task check`. Private panel `PORT=3311 DB_NAME=gss_b` (+ `deno task migrate up`), a scratch agent enrolled to it with its own `--config`, data root and `egressTable` (or a fake-agent WebSocket that answers provision ok): set a user's quota (servers 1, RAM 2048) → create one → second create 409; fire two creates in parallel with `curl … & curl … & wait` → exactly one 201; PATCH a variable bound to memory over the limit → 409, row unchanged; two parallel limit raises on two servers → one 409; admin creates past the defaults; `GET /api/quota` numbers match a hand `SELECT`; backups counted across servers; non-admin USERS_MANAGE editing own quota → 403. Client: `npm run typecheck && npm run build`, Playwright with mocked `/api/quota` + `/api/users/*/quota`, screenshots light + dark |
| **B: server sharing** | Medium (access table is security-relevant but `ServerAccess` exists): `builder` (reviewer checks the level table) | `servers/ServerAccess.ts` (scopeOf, audience + share index, init), `servers/ShareService.ts`, `controllers/ShareController.ts`, `models/ServerShare.ts`, `gateways/live/LiveGateway.ts` (`dropTopic`), `client/src/components/{ServerSharing,Console}/**`, `client/src/pages/{ServerDetail,Servers}/**` (Sharing tab, gating by `access`, "Shared by" badge) | level table, `ServerShareDto`/`CreateShareBody`/`UpdateShareBody`, `GameServerDto.access`, `ServerAccess.audience` | `deno task check`. Private panel `PORT=3312 DB_NAME=gss_c` + fake agent: owner shares with user2 as `view` → user2 lists it, detail 200, start 404, `/ws/live` subscribe ok and receives `server.state`; role → `operate` → start ok, PATCH 404; → `manage` → files/backups ok, DELETE server 404, shares 404; remove share while user2 is subscribed → stream stops, user2 gets `server.updated`, detail 404; user2 leaves a share himself; share with owner/self 400, unknown 404, 21st 409. Client: typecheck + build, Playwright with mocked access levels (view/operate/manage/owner): buttons and tabs hidden or disabled, Sharing tab CRUD; screenshots |
| **C: TOTP 2FA** | **Hard** (auth, replay, single-use codes, brute force): `builder-opus` | `lib/totp.ts`, `models/RecoveryCode.ts`, the `//#region TOTP` of `models/User.ts`, `controllers/AuthController.ts` (`/login/totp`), `controllers/TotpController.ts`, `client/src/pages/{Login,Account}/**`, `client/src/components/{TwoFactorCard,TotpSetupDialog}/**`, `client/src/controllers/AuthController.ts` | TOTP routes and shapes in `shared/api/auth.ts`, `User.findByChallenge`, `RecoveryCode.issue/consume/countLeft` | `deno task check`; scratch `deno run server/src/test-totp.ts` (delete after) checks RFC 6238 appendix B vectors (SHA-1 secret `12345678901234567890`: 59 → 94287082, 1111111109 → 07081804, truncated to 6 digits) and base32. Private panel `PORT=3313 DB_NAME=gss_d`: setup → compute codes with `oathtool --totp -b <secret>` (or the scratch script) → confirm → 10 codes; login → challenge → code → session; same code again → 401; recovery code once ok, twice 401; 11 wrong codes → 429; password change between steps → 401; disable needs password + code; admin reset → user's token 401, login without code. Client: typecheck + build, Playwright: setup dialog shows a QR (screenshot) + secret, codes shown once with copy/download, login second step with "Use a recovery code" |
| **D: host grants + agent install** | Medium (Bash, systemd, distro detection): `builder` | `controllers/HostController.ts` (grant routes, list rules, `canCreate`), `models/{Host,HostGrant}.ts` (serializer `canCreate`, grant finders), `controllers/AgentController.ts`, `controllers/EnrolTokenController.ts`, `scripts/install-agent.sh`, `agent/packaging/gss-agent.service` (if the unit changes, the script's copy changes with it), `client/src/components/{HostGrants,EnrolDialog}/**`, `client/src/pages/{HostDetail,ServerCreate}/**` | grant routes, `HostDto.canCreate`, `CreateHostGrantBody`, agent routes, `installCommand`, script flags/exit codes | `deno task check`; `bash -n` + `shellcheck scripts/install-agent.sh`. Private panel `PORT=3314 DB_NAME=gss_e` with `make dist` output in `AGENT_DIST_DIR`: grant/revoke by curl, user2's `GET /api/hosts` and `canCreate` follow; create on an ungranted host 403. `curl …/api/agent/install.sh` has the URL baked in; download + `sha256sum -c`. In `docker run --rm debian:12` and `archlinux:latest` (with `--network host` to reach the panel): `--dry-run` prints the pacman/apt steps and downloads + verifies the binary; a real install only inside a throwaway systemd container or VM, never on this machine. Client: typecheck + build, Playwright: enrol dialog shows the one-liner, grants card add/remove, picker hides non-`canCreate` hosts |
| **E: admin docs** (after integration) | Easy: `builder` | `README.md`, `docs/admin/{install-panel,add-host,game-sources,users-and-quotas}.md` | `~/.claude/rules/docs.md` (app README: pitch, `## Key Features`, screenshots, short technical section); the behaviour as integrated | Every command in the docs run once against a private panel (copy-paste works); screenshots from the integrated build |

Order: A, B, C, D in parallel; E after integration (the docs describe what was verified, not the plan). A ↔ B
meet only in `GameServerService` (A's quota regions vs the access wiring already done) and `BackupService`
(A's slot check vs `ServerAccess.audience`, done). C stands alone. D ↔ A at `canCreate` vs quota (independent
checks at create). Builders never stop the dev instance (:3200/:5200) or its agent, never `pkill` by pattern, and use
their own port, scratch DB (create `gss_e` like the others), agent config, data root and `egressTable`. Integration
(main): a second (non-admin) user on this machine limited by quota, granted one host, a server shared with them at
`operate`, 2FA on for both users, and a fresh host installed with the one-liner in a VM or systemd container.

## M6: agent updates

Hosts show which agent build they run and can update it from the panel. Contract: `protocol/schema/host.json`
(`HostFacts.agentBuild`, request `agent.update`, event `agent.updateStatus`), `HostDto.agent` / `UpdateHostBody.autoUpdateAgent`.

- **Builds.** `lib/agentBuilds.ts` (`AgentBuilds`) is the one reader of `AGENT_DIST_DIR` (`gss-agent-<os>-<arch>` +
  `.sha256`), shared by `AgentController` and the updater. `latest(os, arch)` is cached for 5 s, so the host list
  stays cheap, and answers null for no build or an unreadable checksum (logged). The arch is `facts.os.arch`, the
  OS is always `linux`.
- **`hosts/AgentUpdater.ts`** keeps the update status per host id in memory (gone after a panel restart; the next
  hello compares builds anyway). `request(host, "manual" | "auto", actorId?)` asks the agent, audits
  `host.agent_update` `{ build, reason }` and pushes `host.updated`; `onStatus` (handler `agentUpdateStatus.ts`)
  stores events; `onHello` (called by `hello.ts` after the facts are stored) settles the earlier update: the requested
  build clears it, another build after `restarting` marks it `failed`, a status still downloading or waiting is
  dropped (the agent restarted and forgot it). `autoUpdate(host)` runs after the hello answer, like reconcile.
  `describe(host)` fills `HostDto.agent`; models can't import gateways, so controllers pass it to
  `Host.toClientJSON(online, count, agent, canCreate)`.
- **Loop guard.** An automatic update that fails (the agent's `failed` status, a restart into another build, or an
  error answering the request) is remembered as host id → target build. Automatic updates skip that build until the
  panel serves another one, someone clicks Update, or the setting is switched on again.
- **Races.** Status events travel on another queue than the answer to `agent.update`, so `request` applies the answer
  only when no event for that build arrived meanwhile. The last requested build and reason are kept apart from the
  shown status (a reconnect drops that), so a late event is still attributed to an automatic or manual update.
- **Visibility.** `HostDto.agent.update` (running operations, agent messages) is sent only to HOSTS_MANAGE; the
  builds and `upToDate` go to everyone who sees the host.
- **Download limit.** Agents send `Authorization: Bearer <host credential>` and `X-Gss-Host` on their update download;
  a valid pair skips the per-IP limit of `/api/agent` (a wrong one counts as anonymous).
- **Agents older than M6** answer `unsupported`; the panel's 409 tells the admin to run the install command once.
  Their `agentBuild` is stored as null, shown as "Unknown".
- **Client.** `AgentBuild` (badge: Up to date / Update available / Unknown, also on the host list for outdated
  hosts) and `AgentUpdate` (card on the host page for HOSTS_MANAGE: builds, progress line, Update button, automatic
  switch, install hint for unknown builds). Both refetch on `host.updated`.

## M7: email

An admin configures an SMTP relay in the panel (`/settings`). With mail on: password links (forgot password, admin
"send password link", a welcome "set your password" link for accounts an admin creates with an address), address
confirmation (with an optional "require a confirmed address to sign in"), email two-factor, and security notices.
The explainer is the artifact "GSS Email Relay". **No protocol change.**

### Contracts

- **Shapes:** `shared/api/settings.ts` (new), `shared/api/auth.ts` (`LoginResponse.step`, `TwoFactorChallenge.methods/
  emailHint/emailSent`, `EmailConfirmationRequired`, `TotpLoginBody.method`, `TotpDisableBody.method`, password link,
  email address and email two-factor regions, `TotpStatusResponse.email*`), `shared/api/users.ts`
  (`UserDto.emailVerifiedAt/pendingEmail/emailTwoFactor/hasPassword`, optional `CreateUserBody.password` +
  `sendWelcomeEmail`, `PasswordLinkSentResponse`), `shared/api/meta.ts` (`mailEnabled`, `requireConfirmedEmail`),
  `LIMITS.EMAIL_*`/`PASSWORD_*_TTL_*` in `shared/constants.ts`, live `settings.updated`.
- **Migration** `20261122000000-m7-email.ts`: `settings` (key PK, JSON text), `email_tokens` (user FK cascade,
  `purpose`, `token_hash` CHAR(64), `email`, `attempts`, `expires_at`, `used_at`; indexes `token_hash`,
  `(user_id, purpose)`), users `email_verified_at`, `pending_email`, `email_two_factor`, `has_password` (default true).
- **Settings** (`models/Setting.ts`): `Setting.get(key)` / `set(key, value)` with an in-memory cache loaded on first
  use; defaults when no row (`mail`: disabled, port 587, `starttls`, `verifyCertificate` true, everything else
  empty/false). The SMTP password is stored only as `passwordBox` from `lib/secretBox.ts`: AES-256-GCM, key =
  HKDF-SHA-256(`JWT_SECRET`, info `"gss-settings-v1"`), output `v1.<iv b64url>.<ciphertext b64url>`; `open()` returns
  null when it can't decrypt (→ `passwordUnreadable`). WebCrypto only.
- **Mailer** (`mail/Mailer.ts`, static): the only importer of `nodemailer` (pinned `10.3.1` in `deno.json`).
  `isEnabled()` (sync, from the settings cache), `send(to, message)` (throws `HttpError` 502 with the server's answer;
  `connectionTimeout`/`greetingTimeout` 10 s, `socketTimeout` 20 s), `sendInBackground(to, message)` (logs failures,
  never throws), `test(to, draft?)`, `reload()` after a settings change (rebuilds the transport). `security` maps to
  nodemailer as `tls` → `secure: true`; `starttls` → `secure: false, requireTLS: true`; `none` → `secure: false,
  ignoreTLS: true`; `verifyCertificate` false → `tls.rejectUnauthorized: false`. `From:` = `"<fromName ?? APP_NAME>"
  <fromAddress>`.
- **Templates** (`mail/templates.ts`, pure): `MailTemplates.<kind>(data) → { subject, text, html }` for `confirm`,
  `reset`, `welcome` (says whether a password was already given), `loginCode`, `actionCode`, `passwordChanged`,
  `emailChangeRequested` (to the old address), `twoFactorOff`, `test`. Every user-supplied value is HTML-escaped; a
  small inline-styled layout, no images, no remote content. Links are `PUBLIC_URL` + `/reset-password?token=…`,
  `/confirm-email?token=…` (helper in `lib/panelUrl.ts` if needed).
- **Email tokens** (`models/EmailToken.ts`). Link tokens: 32 random bytes base64url (`randomToken("")`), codes: 6
  digits from `crypto.getRandomValues` without modulo bias; both stored as `sha256Hex`. `issueLink(userId, purpose,
  email, ttlMs, t?)` and `issueCode(userId, purpose, email)` first delete that user's unused tokens of the same purpose
  (one live link/code per purpose; `reset` and `welcome` replace each other). `findLink(token, purposes)` (preview,
  doesn't use it). `consumeLink(token, purposes)`: conditional `UPDATE … SET used_at WHERE token_hash AND purpose IN
  AND used_at IS NULL AND expires_at > now`, then loads the row; 0 rows → null. `consumeCode(userId, purpose, code)`:
  the newest unused unexpired row; conditional `attempts = attempts + 1 WHERE attempts < EMAIL_CODE_MAX_ATTEMPTS`
  first (0 rows → null), then constant-time compare (`digestEquals`), then conditional `used_at`. `revoke(userId,
  purposes, t?)`. Expired and used rows older than a day are deleted on a 1-hour interval started from `index.ts`
  (`EmailToken.startSweep()`).
- **Cooldown:** one email per user and kind per `LIMITS.EMAIL_RESEND_SECONDS` (in memory, key `<userId>:<kind>`).
  User-facing sends answer 429 "Wait a minute before asking for another email." + `Retry-After`; forgot password and
  notices skip silently.
- **User** (`models/User.ts`, `//#region Email (M7)`): `isEmailConfirmed()` (email set and `emailVerifiedAt`),
  `secondFactorMethods()` (`totp` if `totpEnabled`, `email` if `emailTwoFactor`), `hasSecondFactor()`,
  `maskedEmail(address)` (`a•••@example.com`: first character, `•••`, domain). `findByChallenge(token, purpose)` now
  takes the purpose (`totp` second step: any second factor on; `confirm`: 30 min, for the login gate).
  `consumeSecondFactor(code, method?)`: 6 digits + method `email` → `EmailToken.consumeCode(id, "login" | "action",
  …)` (callers pass which), 6 digits otherwise → TOTP, anything else → recovery code; recovery codes are accepted
  whenever any second factor is on. `clearTotp()` deletes recovery codes only when email two-factor is off too.
  `registerUser` gets `password?: string | null` (null → random unusable hash and `hasPassword` false) and resets
  nothing else. Every place that sets a password sets `hasPassword` true.
- **Login order** (`AuthController`, one helper `beginSession(user, ip)` used by login, register and reset):
  password → **gate**: mail on + `requireConfirmedEmail` + not admin + not `isEmailConfirmed()` → no address: 403 "Your
  account needs a confirmed email address. Ask an administrator to add one."; else `EmailConfirmationRequired` →
  **second factor**: methods non-empty → `TwoFactorChallenge` (email the only method: send a `login` code now and set
  `emailSent`; a failed send logs and answers `emailSent: false`) → session. Every `LoginSuccess` gets `step: "done"`.
  `/login/totp` counts every attempt in `hitSecondFactor` as before, with method `email` checking a `login` code.
  `/login/email-code` and `/login/confirm-email/resend` take the challenge (purpose `totp` / `confirm`) and count in
  `loginPerIp`.
- **Password links:** `/password/forgot` (`publicPerIp`; 409 "Password reset by email isn't set up on this panel.
  Ask an administrator." while mail is off) finds the user by username, else by `email` (lowercased), skips disabled
  users and users without an address, then `sendInBackground` a `reset` link (`PASSWORD_RESET_TTL_MINUTES`); always
  `OkResponse`. `/password/reset/:token` (`publicPerIp`) previews `reset`/`welcome`. `/password/reset`
  (`publicPerIp`): validates the password first, consumes the link, sets the password + `hasPassword`, bumps
  `tokenVersion`, revokes the user's other `reset`/`welcome` tokens, marks the address confirmed when the link's
  `email` equals `user.email`, closes live sockets (`UNAUTHORIZED`), notices `passwordChanged` (not for `welcome`),
  audit `user.password_reset { kind }`, then `beginSession`. Disabled user → 400 like an unusable link.
- **Welcome:** `POST /api/users` with an address, mail on and `sendWelcomeEmail !== false` → `welcome` link
  (`PASSWORD_SETUP_TTL_HOURS`) sent with `send` after the user is created (a failed send keeps the user and answers
  201; the client then offers "Send password link" — log it and audit `user.welcome_failed`). Without a password:
  400 unless an address is given, mail is on and the welcome email isn't turned off. `POST /api/users/:id/password-link`
  (`assertMayManage`, 409 no address / mail off) → `welcome` when `!hasPassword`, else `reset`; audit
  `user.password_link_sent`.
- **Address:** `POST /auth/email` (password checked first, 401). Same address → no change. Mail on: `pendingEmail` =
  new (409 when another account has it as `email`), `confirm` link to it, `emailChangeRequested` notice to the old
  address. Mail off: `email` = new, `emailVerifiedAt` null. `null` removes (`email`, `pendingEmail`,
  `emailVerifiedAt` cleared; 409 rules in `ChangeEmailBody`). `/email/resend` sends a `confirm` link to `pendingEmail
  ?? email` (409 when nothing is unconfirmed). `/email/cancel` clears `pendingEmail` and revokes `confirm` tokens.
  `/email/confirm` (public, `publicPerIp`): link `email` = `pendingEmail` → swap (`email` = pending, verified now,
  pending null; unique clash → 409 and keep pending); = `email` → verified now; otherwise 400 "This link is for an
  address that's no longer on the account." Registration and setup with an address send a `confirm` link when mail
  is on (background). Admin PATCH of `email`: `emailVerifiedAt` null, `pendingEmail` null, `emailTwoFactor` false
  (audit change `emailTwoFactor`), revoke `confirm`/`login`/`action` tokens, `confirm` link to the new address.
  Live `user.updated` after every change; audit `user.email_change_requested`, `user.email_confirmed`,
  `user.email_removed`.
- **Email two-factor:** `enable` (password, 401; 409 "Confirm your email address first." / "The panel doesn't send
  email." / already on) → `emailTwoFactor` true; when no recovery codes are left unused and TOTP is off, issue new
  ones and return them. `disable` → proof like TOTP disable (`TotpController.assertSecondProof` moved to a shared
  helper, with `method`; `email` codes here are purpose `action`) → off, recovery codes removed when TOTP is off too,
  notice `twoFactorOff`. `/email-2fa/code` (signed in, `emailTwoFactor` on) sends an `action` code. TOTP disable and
  recovery codes accept `method: "email"` too. Admin "Reset two-factor" (`/users/:id/totp/reset`) clears both
  methods. Audit `user.email_2fa_enabled`, `user.email_2fa_disabled`; login audit `{ method: "email" }`.
- **Notices** (all `sendInBackground`, only with mail on and an address, never block the request): password changed
  (own change, reset, admin set), address change requested (old address), two-factor turned off (either method,
  admin reset).
- **Settings routes** (admin): `GET /mail` → DTO. `PUT /mail` validates (host 1-255 chars without spaces, port 1-65535,
  `security` enum, `fromAddress` via `User.normalizeEmail`, `fromName` ≤ 64, username ≤ 255, password ≤ 255;
  `enabled` true needs host + fromAddress; `requireConfirmedEmail` true needs `enabled`), saves, `Mailer.reload()`,
  audit `settings.mail_changed { changes }` (field names only), live `settings.updated` to `{ all: true }`. `POST
  /mail/test`: rate-limited per user (10 per window), `await Mailer.test` → `OkResponse` or 502; audit
  `settings.mail_tested { to, ok }`.
- **Meta:** `mailEnabled` = `Mailer.isEnabled()`, `requireConfirmedEmail` = enabled && setting.
- **Client.** Pages: `Settings` (mail card: enable switch, host/port/security/login/password (placeholder "Stored —
  leave blank to keep" when `hasPassword`, a "Remove" action), sender, verify certificate, "Require a confirmed email
  address to sign in" with a hint that existing users without one will be asked to confirm at their next sign-in;
  "Send test email" with the form's current values to the admin's own address by default; Save), `ForgotPassword`,
  `ResetPassword` (preview first; "Set your password" for `welcome`, "Choose a new password" for `reset`; after
  success adopt the session or continue into the two-factor step), `ConfirmEmail` (a button, never on page load:
  mail scanners open links). Login: "Forgot password?" when `mailEnabled`; second step by `methods` (TOTP field, "Email
  me a code instead" / "Send again" with a `EMAIL_RESEND_SECONDS` countdown, recovery code link; email only: "We sent
  a code to a•••@example.com"; `emailSent: false` → error line + "Send again" + recovery code); `confirm_email` step
  ("Confirm your email address" + "Send the link again"). Register: email required when `requireConfirmedEmail`;
  handles `confirm_email`. Account: `EmailCard` (address + Confirmed/Unconfirmed badge, pending change with
  resend/cancel, change dialog with password), `TwoFactorCard` gains the email method (switch on with password, codes
  shown once when returned; disable/recovery dialogs let you pick authenticator code / email code ("Send code") /
  recovery code). Users: create dialog with optional password when an address is given and mail is on, "Send welcome
  email" checkbox (default on); list shows Unconfirmed / No password yet badges; row action "Send password link".
  `useAuth`/meta refetch on `settings.updated`.

### API routes (M7)

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET·PUT | /api/settings/mail | admin | `UpdateMailSettingsBody` | `MailSettingsDto`; 400 |
| POST | /api/settings/mail/test | admin, RL | `TestMailBody` | `OkResponse`; 502 SMTP error |
| POST | /api/auth/login/email-code | challenge, RL | `ChallengeBody` | `EmailCodeSentResponse`; 401, 429 |
| POST | /api/auth/login/confirm-email/resend | challenge, RL | `ChallengeBody` | `OkResponse`; 401, 429 |
| POST | /api/auth/password/forgot | -, RL | `ForgotPasswordBody` | `OkResponse`; 409 mail off |
| GET | /api/auth/password/reset/:token | -, RL | | `PasswordLinkPreviewResponse` |
| POST | /api/auth/password/reset | -, RL | `ResetPasswordBody` | `LoginResponse`; 400 |
| POST | /api/auth/email | S | `ChangeEmailBody` | `UserDto`; 401, 409 |
| POST | /api/auth/email/resend | S | | `OkResponse`; 409, 429 |
| POST | /api/auth/email/cancel | S | | `UserDto` |
| POST | /api/auth/email/confirm | -, RL | `ConfirmEmailBody` | `ConfirmEmailResponse`; 400, 409 |
| POST | /api/auth/email-2fa/enable | S | `EmailTwoFactorEnableBody` | `EmailTwoFactorEnableResponse`; 401, 409 |
| POST | /api/auth/email-2fa/disable | S | `EmailTwoFactorDisableBody` | `UserDto`; 401 |
| POST | /api/auth/email-2fa/code | S | | `EmailCodeSentResponse`; 409, 429 |
| POST | /api/users/:id/password-link | P:USERS_MANAGE | | `PasswordLinkSentResponse`; 403, 409 |

Changed: `/auth/login`, `/auth/login/totp`, `/auth/register`, `/auth/setup`, `/auth/password` answer `step`;
`/auth/register` and `/auth/password/reset` answer `LoginResponse`; `POST /api/users` password optional.

### Boundaries added in M7

| From | May import | Never |
| --- | --- | --- |
| `mail/Mailer.ts` | `nodemailer`, `Setting`, `lib/secretBox`, `Config`, `@shared` | controllers, `User` |
| `mail/templates.ts` | `@shared/constants`, `Config.PUBLIC_URL` | anything with I/O (pure) |
| controllers | `Mailer`, `MailTemplates`, `EmailToken`, `Setting` (via `models/index.ts`) | `nodemailer` |
| `lib/secretBox.ts` | WebCrypto, `Config.JWT_SECRET` | models |

### M7 work split

Main session (done): every shared contract, the migration, `models/index.ts`, the column declarations in `User.ts`,
skeletons of `Setting.ts`, `EmailToken.ts`, `SettingsController.ts`, `EmailController.ts` and the four pages,
`ApiController.ts`, `deno.json` (nodemailer), `client/src/Api/{AuthApi,UserApi,SettingsApi}.ts`, `routes.tsx` (`admin`
requirement), `AppLayout.tsx` (Settings nav), `docker-compose.dev.yml` (Mailpit: SMTP 127.0.0.1:1025, inbox
http://localhost:8025, API `/api/v1/messages`, `/api/v1/message/<ID>`).

| Parcel | Route | Owns | Verify on its own |
| --- | --- | --- | --- |
| **A1: mail + settings** | `builder-opus` (crypto at rest, SMTP failure modes) | `lib/secretBox.ts`, `mail/{Mailer,templates}.ts` (signatures fixed in the skeletons), `models/Setting.ts`, `controllers/{Settings,Meta}Controller.ts` | `deno task check` (server part). Private panel `PORT=3321 DB_NAME=gss_m7a`, relay = Mailpit: GET defaults; PUT validation (each field 400); enabling without host 400; password → DB row holds a `v1.` box only, GET says `hasPassword`; test to Mailpit ok (read it back from the API, check From/subject/HTML), test with draft port 1 → 502 with message; changed `JWT_SECRET` → `passwordUnreadable`; non-admin 403; meta flags follow. Templates rendered once each into Mailpit (scratch script, deleted after) |
| **A2: auth flows** | `builder-opus` (auth, single-use tokens, enumeration) | `models/EmailToken.ts`, `models/User.ts` (logic, `//#region Email (M7)`), `models/Invite.ts` (`redeem` email rule), `controllers/{Auth,Email,Totp,User}Controller.ts`, `server/src/index.ts` (sweep start only) | Codes against the `Mailer`/`MailTemplates` signatures; until A1 lands, a local stub in a scratch copy is fine but the committed files stay A1's. `deno task check`. Private panel `PORT=3322 DB_NAME=gss_m7b` (after A1, or with mail settings written straight into `settings` as JSON with `passwordBox` null), relay = Mailpit: forgot for unknown/known user → same answer, one email; reset link twice → 400; welcome create without password → link → set → login; email change → pending + notice to old + confirm swaps; gate on → non-admin gets `confirm_email`, admin doesn't; email 2FA login: code, wrong ×5 → code dead, replay → 401, resend within 60 s → 429; mail off with email-only 2FA → `emailSent` false, recovery code works; admin email PATCH turns email 2FA off |
| **B: client** | `builder` | `pages/{Settings,ForgotPassword,ResetPassword,ConfirmEmail,Login,Register,Account,Users}/**`, `components/{EmailCard,TwoFactorCard,EmailTwoFactorDialog,...}/**` (new ones as needed), `controllers/AuthController.ts`, `hooks/useAuth.ts` if needed | `cd client && npm run typecheck && npm run build`; Playwright against Vite with mocked `/api/*` (all shapes from `shared/`): every new page and step, light + dark screenshots of Settings, Login (email step), Account cards |

A1, A2 and B share only the contracts above (A2 calls A1 only through the `Mailer`/`MailTemplates` signatures). Integration (main): both against the dev panel + Mailpit, end to end in a
headless browser, then `reviewer`.

### Review fixes (M7)

From the integrated review; all in the contract above now:

- **Password links follow the address.** `/password/reset` refuses a link whose `email` isn't the account's current
  `email` (400, same message as an unusable link). Every address change (admin PATCH, own change with mail off,
  removal, the pending swap in `/email/confirm`) revokes `reset`, `welcome`, `login` and `action` tokens; every
  password set (`/auth/password`, `/users/:id/password`, reset) revokes `reset` and `welcome`. `consumeCode` also
  requires `row.email === user.email`.
- **Adding or moving a factor needs the factor already on.** `SecondFactorProof` (password + code + method) is
  required, when `hasSecondFactor()`, by `POST /auth/email` (change or remove your address), `/email-2fa/enable`
  (when TOTP is on) and `/totp/setup` (when email two-factor is on; `TotpSetupBody`). TOTP confirm keeps the existing
  recovery codes (`recoveryCodes: null`) when email two-factor was on. A "two-factor turned on" notice
  (`MailTemplates.twoFactorOn`) goes out when either method is turned on.
- **After a password link, the inbox isn't enough.** The `totp` challenge issued by `/password/reset` carries
  `viaLink: true`; with TOTP on, its `methods` is `["totp"]` only and `/login/totp` refuses `method: "email"` for it
  (recovery codes still work). Email-only users keep `["email"]` (documented: email two-factor protects against a
  leaked password, not a lost inbox).
- **Forgot password can't cancel other links.** A forgot request skips (silently) when the user has a live `reset`
  link issued under 15 minutes ago, never replaces a live `welcome` link, and sends a `welcome` link instead of a
  `reset` link when `!hasPassword`.
- **The stored SMTP password only goes to the server it was saved for.** When `host`, `port`, `security` or
  `username` in a test draft or a PUT differs from the stored value and no `password` is given, a test sends without
  the stored password and a PUT is refused (400 "password: enter the SMTP password again: the server settings
  changed."). The client says so next to the password field.
- **Smaller:** background sends release their cooldown when the relay fails (`Mailer.send` inside the background
  task); `assertPassword` counts before checking (like `hitSecondFactor`) and resets on success.

## M8: game settings

A server's **Game settings** tab edits the game's own config files (Minecraft: `server.properties`) through a typed
form described by the definition's `settings:` block. The explainer is the artifact "GSS Game Settings Tab".
**No agent change:** the panel reads and writes the files through the existing `files.read` / `files.write`.

### Contracts

- **Schema.** `definition.json` `SettingsSpec {version, version_file, files}` → `SettingsFile {file, format, label,
  others, groups}` → `SettingsGroup {name, description, fields}` → `SettingField {key, label, description, type
  (SettingType: string|number|boolean|select), options, labels, default, min, max, integer, unit, pattern, since,
  until, when}`. `settings` never reaches the `ServerSpec`; a child definition's `settings` replace the parent's.
- **The file is the source of truth.** Values are never stored in the DB. A save rewrites only the changed keys
  (other lines byte-identical, missing keys appended in key order), so the game's own edits (`/whitelist on`) and
  hand edits in the Files tab survive. Keys `configs.set` manages in the same file are never listed, can't be
  declared (sync error) and are refused on save. Changes apply at the next start.
- **Versions.** `GameSettings.compareVersions` compares numeric segments (`1.21.4 < 26.1`, `1.21 == 1.21.0`).
  The version is the first line of `version_file` (Minecraft's install hook writes `gss-version` for every flavour),
  else the rendered `version` template; a non-version (`latest`) is unknown, and then `until` fields are hidden and
  `since` fields shown. A key may be declared several times with disjoint ranges; the first applicable field wins.
- **`others: true`** lists undeclared, unmanaged keys found in the file as `string` fields in a last group "Other";
  saving such a key is allowed only while it is in the file. `hide` keys (container-breaking, unpublished ports,
  secrets) are never listed and refused on save. A settings file may not also be a `template` config or a config of
  another format (gss-init would undo saves), and settings paths have no `.` segments (`./x` would dodge the
  managed-key match).
- **Formats.** `GameSettings.FORMATS` (`read`, `write`); only `properties`, which mirrors
  `agent/internal/initd/configs/properties.go` (Java escaping, `\uXXXX` for non-ASCII, continuation lines, CRLF).
  Sync refuses other formats in `settings` until they have a codec here.
- **Concurrency.** Each file's `modifiedAt` goes to the client and back: a stale one is a 409 before anything is
  written (null = "didn't exist", so a file the game created since is a 409 too), and the write checks the freshly
  read one. The client keeps the edits across a stale-file 409. Values are validated for every file before the first write;
  writes are sequential per file (not atomic across files). No per-server lock (it is held for whole installs).

### API routes (M8)

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| GET | /api/servers/:id/game-settings | manage | | `GameSettingsResponse`; 404 no `settings`; 409 host offline |
| PUT | /api/servers/:id/game-settings | manage | `UpdateGameSettingsBody` | `GameSettingsResponse`; 400 naming `"Label" (key)`; 409 file changed |

`GameServerDetailResponse.hasGameSettings` shows the tab. `PUT` audits `game_settings.updated` with file and key
names only (values can be passwords).

### Files (M8)

`server/src/definitions/GameSettings.ts` (pure), settings checks in `DefinitionEngine` (`checkSettings`,
`checkSettingsLinks`), `servers/GameSettingsService.ts`, `controllers/GameSettingsController.ts`;
`shared/api/gameSettings.ts`; `client/src/Api/GameSettingsApi.ts`, `client/src/components/GameSettings/`; games:
`minecraft-java/game.yml` `settings`, `hooks/install.sh` (`gss-version`), `README.md`.

### Extension points (M8)

- A settings format = a `SettingsFormat` in `GameSettings.FORMATS` (the sync check follows the registry). Next
  candidates: `yaml` (Paper's `config/paper-global.yml`, `bukkit.yml`, `spigot.yml`), `cfg` (Garry's Mod `server.cfg`).
