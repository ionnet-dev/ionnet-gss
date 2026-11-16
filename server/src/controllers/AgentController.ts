import { Hono } from "hono";
import type { Context } from "hono";
import Path from "node:path";
import { Config } from "../Config.ts";
import { type AppEnv, clientIp } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { isInsecurePanelUrl } from "../lib/panelUrl.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";

/**
 * Where the install script lives, relative to the repo root (the Docker image copies `scripts/`).
 */
export const INSTALL_SCRIPT_PATH = "scripts/install-agent.sh";

/**
 * Systems the panel serves agent builds for (`make dist` in agent/ writes `gss-agent-<os>-<arch>` + `.sha256`).
 */
export const AGENT_PLATFORMS = { linux: ["amd64", "arm64"] } as const;

const publicPerIp = new RateLimiter(Config.RATE_LIMIT_PUBLIC_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "requests from your address");

/**
 * A value safe inside a Bash double-quoted string.
 */
function bashQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

/**
 * The agent file names for an os/arch pair from the URL, or a 400 for anything not in `AGENT_PLATFORMS`.
 */
function resolveBuild(c: Context): { os: string; arch: string; file: string } {
  const os = c.req.param("os") ?? "";
  const arch = c.req.param("arch") ?? "";
  const arches: readonly string[] | undefined = Object.hasOwn(AGENT_PLATFORMS, os) ? AGENT_PLATFORMS[os as keyof typeof AGENT_PLATFORMS] : undefined;
  if (!arches?.includes(arch)) {
    const supported = Object.entries(AGENT_PLATFORMS).flatMap(([name, list]) => list.map((a) => `${name}/${a}`)).join(", ");
    throw HttpError.badRequest(`The panel has no agent for ${os}/${arch}. Supported: ${supported}.`);
  }
  return { os, arch, file: Path.resolve(Config.AGENT_DIST_DIR, `gss-agent-${os}-${arch}`) };
}

function missingBuild(os: string, arch: string): HttpError {
  return HttpError.notFound(`The panel has no agent build for ${os}/${arch}. Run \`make dist\` in agent/ (the Docker image includes it).`);
}

/**
 * The first line of a small text file, or null when it doesn't exist.
 */
async function readLine(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).split("\n")[0].trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * `/api/agent` (M5): public downloads for setting up a host. No auth (the enrol token is what grants access, and it
 * goes to `/ws/agent`, never here); rate-limited per IP with RATE_LIMIT_PUBLIC_PER_IP. Files are only ever opened
 * by fixed names built from `AGENT_PLATFORMS` and `Config.AGENT_DIST_DIR`, never from raw request input.
 */
export namespace AgentController {
  export const router = new Hono<AppEnv>();

  router.use("*", async (c, next) => {
    publicPerIp.hit(clientIp(c) ?? "unknown");
    await next();
  });

  /**
   * GET /api/agent/install.sh → the install script (`text/x-shellscript; charset=utf-8`) with `@PANEL_URL@` replaced by
   * PUBLIC_URL and `@INSECURE@` by `1` when PUBLIC_URL is plain http:// on a non-loopback host, else `0`.
   */
  router.get("/install.sh", async (c) => {
    let script: string;
    try {
      script = await Deno.readTextFile(Path.resolve(INSTALL_SCRIPT_PATH));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      throw HttpError.notFound(`The panel's install script (${INSTALL_SCRIPT_PATH}) is missing. Run the panel from the repository root, or use the Docker image.`);
    }
    const body = script.replaceAll("@PANEL_URL@", () => bashQuoted(Config.PUBLIC_URL)).replaceAll("@INSECURE@", () => isInsecurePanelUrl() ? "1" : "0");
    return c.body(body, 200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
  });

  /**
   * GET /api/agent/download/:os/:arch → the agent binary, streamed (`application/octet-stream`, `Content-Length`,
   * `Content-Disposition: attachment; filename="gss-agent"`, `X-Gss-Version` from `AGENT_DIST_DIR/VERSION`).
   * 400 unknown os/arch; 404 "The panel has no agent build for linux/arm64. Run `make dist` in agent/ (the Docker
   * image includes it)."
   */
  router.get("/download/:os/:arch", async (c) => {
    const { os, arch, file } = resolveBuild(c);
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(file, { read: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw missingBuild(os, arch);
      throw error;
    }
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      handle.close();
      throw error;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": `${size}`,
      "Content-Disposition": "attachment; filename=\"gss-agent\"",
    };
    const version = await readLine(Path.resolve(Config.AGENT_DIST_DIR, "VERSION"));
    if (version) headers["X-Gss-Version"] = version;
    return new Response(handle.readable, { status: 200, headers });
  });

  /**
   * GET /api/agent/download/:os/:arch/sha256 → the hex SHA-256 of that binary (`text/plain`), from its `.sha256` file.
   */
  router.get("/download/:os/:arch/sha256", async (c) => {
    const { os, arch, file } = resolveBuild(c);
    const digest = await readLine(`${file}.sha256`);
    if (digest === null) throw missingBuild(os, arch);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`The checksum file for ${os}/${arch} in ${Config.AGENT_DIST_DIR} is not a SHA-256 digest. Run \`make dist\` in agent/ again.`);
    return c.body(`${digest}\n`, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });
}

export default AgentController;
