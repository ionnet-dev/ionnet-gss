/**
 * Mod catalogs the panel searches and downloads from (never the hosts). One `ModCatalog` per `ModCatalogProvider`
 * (definition.json); a new provider is a value there plus an implementation in `catalogs/` and a line in `CATALOGS`.
 * Implementations only fetch from hosts on MOD_CATALOG_HOSTS (see `ModCatalog.fetchAllowed`), never follow redirects
 * to other hosts, validate every answer's shape (dropping items that don't fit), and throw `HttpError` 502 with a
 * readable message when the catalog fails or answers something unexpected, 429 when it rate limits, 404 for an unknown
 * project or version, 409 when the catalog isn't usable (`unavailable`). Every call takes the context, which carries
 * the operator's credentials for that provider.
 */
import type { ModCatalogProvider } from "@shared/protocol/protocol.gen.ts";
import Config from "../Config.ts";
import { CurseForge } from "./catalogs/CurseForge.ts";
import { Modrinth } from "./catalogs/Modrinth.ts";

export interface ModCatalog {
  /**
   * Display name, e.g. "Modrinth".
   */
  readonly label: string;
  /**
   * Why the catalog can't be used with these credentials (e.g. CurseForge without a key), or null when it can.
   */
  unavailable(ctx: ModCatalog.Context): string | null;
  /**
   * Projects matching `query` (empty = the most downloaded) that have a version for the context.
   */
  search(ctx: ModCatalog.Context, query: string, offset: number, limit: number): Promise<{ hits: ModCatalog.Project[]; total: number }>;
  /**
   * One project, for titles and icons of dependencies.
   */
  project(ctx: ModCatalog.Context, projectId: string): Promise<ModCatalog.Project>;
  /**
   * Several projects at once (unknown ids are left out).
   */
  projects(ctx: ModCatalog.Context, projectIds: string[]): Promise<ModCatalog.Project[]>;
  /**
   * The project's versions compatible with the context, newest first, at most `limit`.
   */
  versions(ctx: ModCatalog.Context, projectId: string, limit: number): Promise<ModCatalog.Version[]>;
  /**
   * One version by id (a pinned dependency or an explicit pick); `compatible` says whether it fits the context.
   */
  version(ctx: ModCatalog.Context, versionId: string): Promise<{ version: ModCatalog.Version; compatible: boolean }>;
  /**
   * Several versions by id (pack imports, e.g. CurseForge file ids); unknown ids are left out. Keyed by version id.
   */
  versionsById(ctx: ModCatalog.Context, versionIds: string[]): Promise<Map<string, ModCatalog.Version>>;
  /**
   * For installed mods of this catalog: the newest compatible version when it is a different one. Keyed by the given
   * `versionId`; mods without an update are absent.
   */
  updates(ctx: ModCatalog.Context, installed: ModCatalog.Installed[]): Promise<Map<string, ModCatalog.Version>>;
  /**
   * Recognise files by SHA-1 (uploads): the version each one is, keyed by the SHA-1. Optional; catalogs that can't look
   * files up by SHA-1 (CurseForge uses its own fingerprint) don't implement it.
   */
  identify?(ctx: ModCatalog.Context, sha1s: string[]): Promise<Map<string, { project: ModCatalog.Project; version: ModCatalog.Version }>>;
}

export namespace ModCatalog {
  /**
   * What the server can run: the folder's project type and rendered loaders, and the installed game version.
   */
  export interface Context {
    projectType: string;
    loaders: string[]; // Empty = any loader.
    gameVersion: string;
    gameId: number | null; // `catalog.game_id` (CurseForge).
    apiKey: string | null; // The operator's key for this provider (Settings), decrypted; null when none.
  }

  export interface Installed {
    projectId: string;
    versionId: string;
    sha1: string | null;
  }

  export interface Project {
    projectId: string;
    slug: string;
    title: string;
    description: string;
    author: string;
    iconUrl: string | null;
    pageUrl: string;
    downloads: number;
    /**
     * False when the author doesn't allow downloads outside the catalog's own app (CurseForge `allowModDistribution`).
     */
    downloadable: boolean;
    /**
     * Where the project runs, when the catalog knows (Modrinth `server_side` / `client_side`): `client` = useless or
     * harmful on a server (pack imports leave such mods unselected). Null when unknown (CurseForge).
     */
    side: "server" | "client" | "both" | null;
  }

  export interface Version {
    projectId: string;
    versionId: string;
    name: string;
    versionNumber: string;
    publishedAt: string; // ISO date
    /**
     * The file to install (the version's primary file). `url` is on an allowed host; `sha1` is lowercase hex and
     * required, `sha512` when the catalog has it (Modrinth; CurseForge only offers SHA-1 and MD5). `headers` go with the
     * download request and every redirect on an allowed host (CurseForge's CDN wants the operator's `x-api-key`). A
     * version without a downloadable file isn't returned.
     */
    file: { url: string; name: string; size: number; sha1: string; sha512: string | null; headers: Record<string, string> };
    dependencies: Dependency[];
  }

  export interface Dependency {
    projectId: string | null;
    versionId: string | null;
    type: "required" | "optional" | "incompatible" | "embedded";
  }

  /**
   * The implementation for each provider.
   */
  export const CATALOGS: Record<ModCatalogProvider, ModCatalog> = {
    // Getters, so importing a catalog module first (it imports this one back) can't hit it before it is initialised.
    get modrinth() {
      return Modrinth;
    },
    get curseforge() {
      return CurseForge;
    },
  };

  /**
   * Whether the panel may fetch `url`: https, no credentials, and its host on MOD_CATALOG_HOSTS.
   */
  export function fetchAllowed(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    // An explicit port other than 443 would reach a different service on an allowed host.
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || (parsed.port !== "" && parsed.port !== "443")) return false;
    const hosts = Config.MOD_CATALOG_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
    return hosts.includes(parsed.hostname.toLowerCase());
  }
}

export default ModCatalog;
