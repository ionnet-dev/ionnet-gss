import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";

/**
 * Where the install script lives, relative to the repo root (the Docker image copies `scripts/`).
 */
export const INSTALL_SCRIPT_PATH = "scripts/install-agent.sh";

/**
 * Systems the panel serves agent builds for (`make dist` in agent/ writes `gss-agent-<os>-<arch>` + `.sha256`).
 */
export const AGENT_PLATFORMS = { linux: ["amd64", "arm64"] } as const;

/**
 * `/api/agent` (M5): public downloads for setting up a host. No auth (the enrol token is what grants access, and it
 * goes to `/ws/agent`, never here); rate-limited per IP with RATE_LIMIT_PUBLIC_PER_IP. Files are only ever opened
 * by fixed names built from `AGENT_PLATFORMS` and `Config.AGENT_DIST_DIR`, never from raw request input.
 */
export namespace AgentController {
  export const router = new Hono<AppEnv>();

  /**
   * GET /api/agent/install.sh → the install script (`text/x-shellscript; charset=utf-8`) with `@PANEL_URL@` replaced by
   * PUBLIC_URL and `@INSECURE@` by `1` when PUBLIC_URL is plain http:// on a non-loopback host, else `0`.
   */
  router.get("/install.sh", async (c) => {
    throw HttpError.notImplemented("GET /api/agent/install.sh"); // TODO(builder): M5
  });

  /**
   * GET /api/agent/download/:os/:arch → the agent binary, streamed (`application/octet-stream`, `Content-Length`,
   * `Content-Disposition: attachment; filename="gss-agent"`, `X-Gss-Version` from `AGENT_DIST_DIR/VERSION`).
   * 400 unknown os/arch; 404 "The panel has no agent build for linux/arm64. Run `make dist` in agent/ (the Docker
   * image includes it)."
   */
  router.get("/download/:os/:arch", async (c) => {
    throw HttpError.notImplemented("GET /api/agent/download/:os/:arch"); // TODO(builder): M5
  });

  /**
   * GET /api/agent/download/:os/:arch/sha256 → the hex SHA-256 of that binary (`text/plain`), from its `.sha256` file.
   */
  router.get("/download/:os/:arch/sha256", async (c) => {
    throw HttpError.notImplemented("GET /api/agent/download/:os/:arch/sha256"); // TODO(builder): M5
  });
}

export default AgentController;
