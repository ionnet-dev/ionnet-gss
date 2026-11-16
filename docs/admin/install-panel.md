# Install the panel

The panel is one Deno service plus a MariaDB database. It serves the web app, the API and the WebSockets the agents and browsers connect to. You can run it with Docker Compose (the production route) or from source.

Hosts that run game servers are separate machines. Add them after the panel works: [Add a host](add-host.md).

## What you need

- A machine for the panel with Docker and Docker Compose (Compose route), or Deno 2, Node 22 and Git (source route).
- MariaDB 11 (the compose file starts one for you). The panel creates its tables itself.
- A DNS name and a TLS certificate for the panel, behind a reverse proxy. See [HTTPS](#https).
- `git` on the panel's machine, because the panel clones game sources. The Docker image has it.

## Docker Compose

`docker-compose.yml` starts MariaDB and the panel. The image builds the web app and the agent downloads inside Docker, so the first build takes a few minutes.

```sh
git clone <repository> ionnet-gss
cd ionnet-gss
cat > .env <<'EOF'
PUBLIC_URL=https://gss.example.com
DB_PASSWORD=change-me
DB_ROOT_PASSWORD=change-me-too
EOF
docker compose up -d --build
```

Compose reads `.env` next to the compose file. The three values above have no default and compose refuses to start without them. Every other setting in [`.env.example`](../../.env.example) that the compose file lists can go in the same file.

What compose sets up:

- The panel listens on `127.0.0.1:3200` on the machine. Put a reverse proxy in front of it. To publish it directly, set `BIND_HOST=0.0.0.0` (and `HOST_PORT` for another port).
- `TRUST_PROXY` is `true` here, so the panel believes `X-Forwarded-For` and `X-Forwarded-Proto`. Make sure the panel's port is reachable only through your proxy.
- Two volumes: `gss-mariadb` (the database) and `gss-panel-data` (the panel's data folder, with the generated `jwt-secret` and the clones of git sources). Back up both. Losing `jwt-secret` signs everyone out.
- Migrations run at startup (`AUTO_MIGRATE=true`).

Check that it is up:

```sh
docker compose ps
curl -s http://127.0.0.1:3200/api/health
```

The second command prints `{"ok":true,"database":"up"}`.

To upgrade, pull the new code and run `docker compose up -d --build` again. Pending migrations apply when the panel starts.

## From source

```sh
git clone <repository> ionnet-gss
cd ionnet-gss
cp .env.example .env              # then edit it, see below
deno task db:up                   # a MariaDB for development on 127.0.0.1:3308
cd client && npm install && cd ..
deno task build                   # builds the web app into client/dist
deno task start                   # production mode: serves client/dist, listens on 0.0.0.0
```

`deno task start` always runs in production mode, with settings from `.env`. Variables already set in the environment win over `.env`.

For a real deployment, point `DB_*` at your own MariaDB and create the database and user first:

```sql
CREATE DATABASE gss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'gss'@'%' IDENTIFIED BY 'change-me';
GRANT ALL ON gss.* TO 'gss'@'%';
```

For hosts to be able to install their agent from this panel, the agent builds must exist in `AGENT_DIST_DIR`. Build them once, which needs Go 1.27:

```sh
cd agent && make dist
```

That writes `agent/dist/gss-agent-linux-amd64` and `gss-agent-linux-arm64`, each with a `.sha256` file. Without them, the install script stops with "The panel has no agent build for linux/amd64". The Docker image already includes them.

`deno task dev` is for working on the panel itself: it proxies the Vite dev server and restarts on changes.

## Settings

All settings are environment variables, read at startup. [`.env.example`](../../.env.example) documents every one. These matter most:

| Setting | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3200` | The address people and agents use to reach the panel. It ends up in enrol commands, invite links and the WebSocket origin check. Set it to the real `https://` address. |
| `PORT`, `HOST` | `3200`, empty | Port and interface. Empty `HOST` means `127.0.0.1` in development and `0.0.0.0` in production. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `127.0.0.1`, `3308`, `gss`, `gss`, `gss` | The database connection. Compose sets these itself. |
| `AUTO_MIGRATE` | `true` | Run pending migrations at startup. |
| `DATA_DIR` | `./data` | Panel data: the generated `jwt-secret` and the git source clones. |
| `JWT_SECRET` | empty | Signs login tokens. Empty generates one on first start in `DATA_DIR/jwt-secret` (mode 0600). Set it yourself (`openssl rand -hex 32`) only if you run more than one panel process. |
| `JWT_TTL_HOURS`, `INVITE_TTL_HOURS` | `168`, `72` | How long a login and an invite link last. |
| `AGENT_DIST_DIR` | `agent/dist` | Where the panel finds the agent builds it serves to the install script. |
| `ENROL_TOKEN_TTL_MINUTES` | `60` | Default lifetime of a host enrol token. |
| `DEFAULT_PORT_POOL` | `25565-25664,27015-27064` | Port pool of newly enrolled hosts. Editable per host afterwards. |
| `DEFAULT_QUOTA_SERVERS`, `_MEMORY_MB`, `_CPU_MILLIS`, `_DISK_MB`, `_BACKUPS` | `2`, `4096`, `2000`, `20480`, `5` | Quota of every user who has no value of their own. See [Users and quotas](users-and-quotas.md#quotas). |
| `IMAGE_REGISTRY` | `ghcr.io/ionnet-dev` | Prefix for the bare `ionnet-gss-*` image names in `game.yml`. |
| `TRUST_PROXY` | `false` (compose: `true`) | Trust `X-Forwarded-*` from a reverse proxy. Only turn it on behind one. |

### Rate limits

Limits are kept in memory per panel process. Over a limit the panel answers 429 until the window ends. `0` turns a limit off.

| Setting | Default | Limits |
| --- | --- | --- |
| `RATE_LIMIT_WINDOW_SEC` | `900` | The window all limits below use (15 minutes). |
| `RATE_LIMIT_LOGIN_PER_IP` | `30` | Sign-in attempts per client IP. |
| `RATE_LIMIT_LOGIN_FAILURES_PER_USER` | `10` | Failed passwords per username (a success resets it). Wrong two-factor codes count here too. |
| `RATE_LIMIT_PUBLIC_PER_IP` | `60` | Requests per IP to setup, register, the invite preview and the agent install downloads. |

Other limits: `BODY_LIMIT_KB` (largest API request, default 1024), `UPLOAD_MAX_MB` (largest file upload in the file manager, default 4096) and `TRANSFERS_PER_USER` (simultaneous uploads and downloads per user, default 4).

Client IPs come from `X-Forwarded-For` only when `TRUST_PROXY=true`. Without it, every request behind a proxy looks like it comes from the proxy and shares one limit.

## First admin account

Open `PUBLIC_URL` in a browser. While the panel has no users, it shows the setup page. Pick a username and a password of at least 10 characters (at most 72 bytes) and an optional email. That account is the first admin.

Setup works only once. Afterwards the same request answers 409 "The panel is already set up". Add people with [invites](users-and-quotas.md#invites).

## Migrations

Migrations run at startup. To run them yourself (for example with `AUTO_MIGRATE=false`):

```sh
deno task migrate up          # apply pending migrations
deno task migrate pending     # list the ones not applied yet
deno task migrate executed    # list the ones applied
```

From the Docker image, run them inside the container: `docker compose exec panel deno run --cached-only -A server/src/migrate.ts up`.

## HTTPS

Run the panel behind a reverse proxy that terminates TLS and passes WebSocket upgrades on two paths: `/ws/agent` (hosts) and `/ws/live` (browsers). An nginx server block looks like this:

```nginx
server {
  listen 443 ssl;
  server_name gss.example.com;
  # ssl_certificate and ssl_certificate_key here

  client_max_body_size 0;

  location / {
    proxy_pass http://127.0.0.1:3200;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
    proxy_request_buffering off;
  }
}
```

(`$connection_upgrade` comes from a `map $http_upgrade $connection_upgrade { default upgrade; "" close; }` in the `http` block.) The snippet is an example and has not been run against this panel.

`client_max_body_size 0` and `proxy_request_buffering off` let file uploads stream through. Agents keep their WebSocket open for as long as they run, so the read timeout should be long.

The agent refuses to enrol against a plain `http://` panel on another machine: "refusing to send credentials over plain http:// to a non-loopback panel: use https://, or pass --insecure if this network is trusted". `http://localhost` is fine for a panel and agent on the same machine. If you must use plain http on a trusted network, `PUBLIC_URL` with `http://` makes the panel add `--insecure` to the commands it shows. The token and the host credential then travel unencrypted. Prefer HTTPS.

### A private certificate authority

If your TLS certificate comes from a private CA, the panel's `git` needs to trust it too when a game source lives on a server with that certificate. The panel passes `GIT_SSL_CAINFO` (or `SSL_CERT_FILE`) and `GIT_SSL_CAPATH` (or `SSL_CERT_DIR`) through to `git`, so set one of them for the panel process. The agents' machines need the CA in their system trust store, because the install script fetches over `curl`.

## Next

- [Add a host](add-host.md)
- [Game sources](game-sources.md)
- [Users and quotas](users-and-quotas.md)
