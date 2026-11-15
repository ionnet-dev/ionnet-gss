/**
 * Panel configuration from environment variables (see `.env.example`). Every variable has a development default, so
 * the panel runs without a `.env`. Without `JWT_SECRET` the panel generates a random secret once and keeps it in
 * `DATA_DIR/jwt-secret` (0600).
 */
import fs from "node:fs";
import Path from "node:path";

/**
 * The placeholder older `.env.example` files shipped. Refused in production.
 */
const OLD_EXAMPLE_JWT_SECRET = "dev-only-jwt-secret-change-me-000000000000";
const JWT_SECRET_MIN = 32;
const JWT_SECRET_FILE = "jwt-secret";

function readString(key: string, fallback: string): string {
  const value = Deno.env.get(key);
  return value === undefined || value === "" ? fallback : value;
}

function readInt(key: string, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be a whole number of at least ${min}, but is "${raw}". Fix it in .env.`);
  }
  return value;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${key} must be "true" or "false", but is "${raw}". Fix it in .env.`);
  }
  return raw === "true";
}

/**
 * The secret from `DATA_DIR/jwt-secret`, created with 32 random bytes (hex, mode 0600) on first use. Synchronous:
 * the config is read once at import time.
 */
function persistedJwtSecret(dataDir: string): string {
  const file = Path.join(Path.resolve(dataDir), JWT_SECRET_FILE);
  try {
    fs.mkdirSync(Path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    // "wx" fails when the file exists, so two panels starting together keep the first one's secret.
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: "wx" });
    console.log(`JWT_SECRET is not set: generated one in ${file}.`);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw new Error(`JWT_SECRET is not set and ${file} could not be created (${(error as Error).message}). Set JWT_SECRET in .env or make DATA_DIR writable.`);
    }
  }
  if (Deno.build.os !== "windows" && (fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  const secret = fs.readFileSync(file, "utf8").trim();
  if (secret.length < JWT_SECRET_MIN) {
    throw new Error(`${file} holds a secret shorter than ${JWT_SECRET_MIN} characters. Delete it to generate a new one (this signs everyone out).`);
  }
  return secret;
}

function load() {
  const env = readString("DENO_ENV", "development") as "development" | "production";
  const dataDir = readString("DATA_DIR", "./data");
  const config = {
    // Server
    PORT: readInt("PORT", 3200, 1),
    // Interface to listen on. Loopback in development; every interface in production (Docker, reverse proxy).
    HOST: readString("HOST", env === "production" ? "0.0.0.0" : "127.0.0.1"),
    PUBLIC_URL: readString("PUBLIC_URL", "http://localhost:3200").replace(/\/+$/, ""),
    DENO_ENV: env,
    VITE_URL: readString("VITE_URL", "http://localhost:5200"),
    CLIENT_DIST: readString("CLIENT_DIST", "client/dist"),
    TRUST_PROXY: readBool("TRUST_PROXY", false),
    DATA_DIR: dataDir,

    // Database
    DB_HOST: readString("DB_HOST", "127.0.0.1"),
    DB_PORT: readInt("DB_PORT", 3308, 1),
    DB_NAME: readString("DB_NAME", "gss"),
    DB_USER: readString("DB_USER", "gss"),
    DB_PASSWORD: readString("DB_PASSWORD", "gss"),
    AUTO_MIGRATE: readBool("AUTO_MIGRATE", true),
    LOG_SQL: readBool("LOG_SQL", false),

    // Auth
    JWT_SECRET: Deno.env.get("JWT_SECRET") || persistedJwtSecret(dataDir),
    JWT_TTL_HOURS: readInt("JWT_TTL_HOURS", 168, 1),
    INVITE_TTL_HOURS: readInt("INVITE_TTL_HOURS", 72, 1),

    // Limits (0 = off for the rate limits)
    BODY_LIMIT_KB: readInt("BODY_LIMIT_KB", 1024, 1),
    RATE_LIMIT_WINDOW_SEC: readInt("RATE_LIMIT_WINDOW_SEC", 900, 1),
    RATE_LIMIT_LOGIN_PER_IP: readInt("RATE_LIMIT_LOGIN_PER_IP", 30, 0),
    RATE_LIMIT_LOGIN_FAILURES_PER_USER: readInt("RATE_LIMIT_LOGIN_FAILURES_PER_USER", 10, 0),
    RATE_LIMIT_PUBLIC_PER_IP: readInt("RATE_LIMIT_PUBLIC_PER_IP", 60, 0),

    // Agents
    ENROL_TOKEN_TTL_MINUTES: readInt("ENROL_TOKEN_TTL_MINUTES", 60, 1),
    AGENT_HEARTBEAT_SEC: readInt("AGENT_HEARTBEAT_SEC", 15, 1),
    AGENT_OFFLINE_AFTER_SEC: readInt("AGENT_OFFLINE_AFTER_SEC", 45, 1),
    AGENT_REQUEST_TIMEOUT_SEC: readInt("AGENT_REQUEST_TIMEOUT_SEC", 30, 1),

    // Hosts
    DEFAULT_PORT_POOL: readString("DEFAULT_PORT_POOL", "25565-25664,27015-27064"),

    // Games
    /** The built-in definition source: the repo's own games/ folder, relative to the repo root. */
    GAMES_DIR: readString("GAMES_DIR", "games"),
    /** Registry prefix for bare `ionnet-gss-*` image names in game.yml; untagged ones get `:latest`. */
    IMAGE_REGISTRY: readString("IMAGE_REGISTRY", "ghcr.io/ionnet-dev").replace(/\/+$/, ""),

    // Quotas (used where a user's own quota field is null)
    DEFAULT_QUOTA_SERVERS: readInt("DEFAULT_QUOTA_SERVERS", 2, 0),
    DEFAULT_QUOTA_MEMORY_MB: readInt("DEFAULT_QUOTA_MEMORY_MB", 4096, 0),
    DEFAULT_QUOTA_CPU_MILLIS: readInt("DEFAULT_QUOTA_CPU_MILLIS", 2000, 0),
    DEFAULT_QUOTA_DISK_MB: readInt("DEFAULT_QUOTA_DISK_MB", 20480, 0),
    DEFAULT_QUOTA_BACKUPS: readInt("DEFAULT_QUOTA_BACKUPS", 5, 0),
  };

  if (config.DENO_ENV !== "development" && config.DENO_ENV !== "production") {
    throw new Error(`DENO_ENV must be "development" or "production", but is "${config.DENO_ENV}".`);
  }
  if (config.JWT_SECRET.length < JWT_SECRET_MIN) {
    throw new Error(`JWT_SECRET is shorter than ${JWT_SECRET_MIN} characters. Generate one with \`openssl rand -hex 32\`, or leave it empty to have the panel keep one in DATA_DIR.`);
  }
  if (config.JWT_SECRET === OLD_EXAMPLE_JWT_SECRET) {
    if (config.DENO_ENV === "production") {
      throw new Error("JWT_SECRET is the placeholder from an old .env.example. Remove it from .env (the panel then keeps a random one in DATA_DIR) or set your own with `openssl rand -hex 32`.");
    }
    console.warn("JWT_SECRET is the public placeholder from an old .env.example. Remove it from .env to use a generated secret.");
  }
  return config;
}

/**
 * The loaded configuration. Read once at startup.
 */
export const Config = load();
export type Config = typeof Config;

/**
 * Whether the panel runs in development (proxies Vite, verbose errors).
 */
export function isDevelopment(): boolean {
  return Config.DENO_ENV === "development";
}

export default Config;
