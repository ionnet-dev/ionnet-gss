import Path from "node:path";
import { Config } from "../Config.ts";

/**
 * Systems the panel serves agent builds for (`make dist` in agent/ writes `gss-agent-<os>-<arch>` + `.sha256`).
 */
export const AGENT_PLATFORMS = { linux: ["amd64", "arm64"] } as const;

/**
 * How long `latest()` reuses a read: the host list asks once per host, and a new build only appears on a panel
 * upgrade.
 */
const CACHE_MS = 5000;

/**
 * The agent builds this panel serves (the files in `Config.AGENT_DIST_DIR`).
 */
export namespace AgentBuilds {
  const _cache = new Map<string, { at: number; digest: Promise<string | null> }>();

  /**
   * Whether the panel has an agent for this os/arch pair at all (not whether the build exists).
   */
  export function isSupported(os: string, arch: string): boolean {
    const arches: readonly string[] | undefined = Object.hasOwn(AGENT_PLATFORMS, os) ? AGENT_PLATFORMS[os as keyof typeof AGENT_PLATFORMS] : undefined;
    return arches?.includes(arch) ?? false;
  }

  /**
   * Absolute path of the binary for a supported os/arch pair.
   */
  export function file(os: string, arch: string): string {
    return Path.resolve(Config.AGENT_DIST_DIR, `gss-agent-${os}-${arch}`);
  }

  /**
   * The first line of a small text file, or null when it doesn't exist.
   */
  export async function readLine(path: string): Promise<string | null> {
    try {
      return (await Deno.readTextFile(path)).split("\n")[0].trim();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  /**
   * The hex SHA-256 in the `.sha256` file next to the binary, read fresh.
   * @returns null when the panel has no build for it.
   * @throws Error when the file isn't a SHA-256 digest.
   */
  export async function readDigest(os: string, arch: string): Promise<string | null> {
    const digest = await readLine(`${file(os, arch)}.sha256`);
    if (digest === null) return null;
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`The checksum file for ${os}/${arch} in ${Config.AGENT_DIST_DIR} is not a SHA-256 digest. Run \`make dist\` in agent/ again.`);
    return digest;
  }

  /**
   * The build the panel serves for an os/arch pair (what `GET /api/agent/download/<os>/<arch>/sha256` answers), cached
   * for a few seconds.
   * @returns null when the platform is unsupported, there is no build, or its checksum file is unreadable (logged).
   */
  export function latest(os: string, arch: string): Promise<string | null> {
    if (!isSupported(os, arch)) return Promise.resolve(null);
    const key = `${os}/${arch}`;
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.digest;
    const digest = readDigest(os, arch).catch((error) => {
      console.error(`agent build ${key} is unreadable`, error);
      return null;
    });
    _cache.set(key, { at: Date.now(), digest });
    return digest;
  }
}

export default AgentBuilds;
