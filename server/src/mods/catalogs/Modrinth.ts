/**
 * Modrinth (API v2) implementation of `ModCatalog`. Only talks to hosts allowed by `ModCatalog.fetchAllowed`, and
 * validates every answer: items that don't have the expected shape are dropped, an answer that isn't the expected
 * kind of JSON at all becomes a 502.
 */
import { HttpError } from "../../lib/HttpError.ts";
import { AppSystem } from "../../AppSystem.ts";
import { ModCatalog } from "../ModCatalog.ts";

//#region Constants
const API_URL = "https://api.modrinth.com/v2";
const SITE_URL = "https://modrinth.com";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BATCH_SIZE = 100; // Modrinth's limit for `ids` and hash lists
const MAX_SEARCH_LIMIT = 100;
const MAX_LIST_ITEMS = 1000; // Most items a list in an answer may have before the rest is ignored
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const USER_AGENT = `ionnet-gss/${AppSystem.version} (game server panel)`;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TYPE_PATTERN = /^[a-z]{1,32}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA512_PATTERN = /^[0-9a-f]{128}$/;
const DEPENDENCY_TYPES = ["required", "optional", "incompatible", "embedded"] as const;
//#endregion

//#region Validation helpers
type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A string capped to `max` characters, or null when `value` isn't a string.
 */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/**
 * A string that matches `pattern` (ids, hashes), or null.
 */
function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * A non-negative finite number, or null.
 */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * An https URL of at most 2048 characters, or null.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The strings of an array (other items are ignored), capped in count and length.
 */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).flatMap((item) => typeof item === "string" ? [item.slice(0, 128)] : []);
}

function unexpected(): HttpError {
  return new HttpError(502, "Modrinth answered with something unexpected.");
}

/**
 * Requires an array answer (capped in length) and maps its items with `parse`, dropping those that return null.
 */
function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) throw unexpected();
  return value.slice(0, MAX_LIST_ITEMS).flatMap((item) => parse(item) ?? []);
}

/**
 * Runs `fn`; anything that isn't an `HttpError` (a parser tripping over an unexpected shape) becomes a 502.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("Modrinth answer couldn't be processed:", error);
    throw unexpected();
  }
}
//#endregion

/**
 * A small in-memory cache whose entries expire after `CACHE_TTL_MS`; the oldest entry goes when it is full.
 */
class TtlCache<T> {
  private readonly _entries = new Map<string, { value: T; expires: number }>();

  public get(key: string): T | undefined {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this._entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(key: string, value: T): void {
    this._entries.delete(key);
    this._entries.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    if (this._entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this._entries.keys().next().value;
      if (oldest !== undefined) this._entries.delete(oldest);
    }
  }
}

const projectCache = new TtlCache<ModCatalog.Project>();
const versionsCache = new TtlCache<ModCatalog.Version[]>();

//#region HTTP
/**
 * Reads a response body as JSON, refusing anything over `MAX_BODY_BYTES` (by `Content-Length` and while streaming).
 */
async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new HttpError(502, "Modrinth's answer is too large.");
  }
  if (!res.body) throw unexpected();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(502, "Modrinth's answer is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, "Modrinth answered with something that isn't JSON.");
  }
}

/**
 * Calls the Modrinth API and returns the parsed JSON (unvalidated). Errors become `HttpError`: 502 for failures,
 * `notFound` (when given) for a 404, 429 when Modrinth rate limits the panel.
 * @param path Path below the API root, including the query string.
 * @param notFound Message for a 404; without it a 404 is a 502 like any other bad status.
 */
async function request(path: string, init: RequestInit = {}, notFound?: string): Promise<unknown> {
  const url = `${API_URL}${path}`;
  if (!ModCatalog.fetchAllowed(url)) throw new HttpError(502, "The panel isn't allowed to contact Modrinth. Add api.modrinth.com to MOD_CATALOG_HOSTS.");

  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new HttpError(502, `Modrinth didn't answer: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new HttpError(502, `Modrinth answered with a redirect (${res.status}), which the panel doesn't follow.`);
    }
    if (res.status === 404 && notFound !== undefined) {
      await res.body?.cancel();
      throw HttpError.notFound(notFound);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("retry-after"));
      throw HttpError.tooManyRequests("Modrinth is rate limiting the panel; try again in a minute.", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await readJson(res);
        const description = isRecord(body) ? text(body.description, 200) : null;
        if (description) detail = `: ${description}`;
      } catch { /* the status alone is enough */ }
      throw new HttpError(502, `Modrinth answered ${res.status} ${res.statusText}${detail}`.trim());
    }
    return await readJson(res);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `Modrinth didn't answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * POSTs a JSON body to `path`.
 */
function post(path: string, body: unknown): Promise<unknown> {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}
//#endregion

//#region Mapping
/**
 * Splits `items` into groups of at most `size`.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function pageUrl(projectType: string, slug: string): string {
  return `${SITE_URL}/${projectType}/${encodeURIComponent(slug)}`;
}

/**
 * A project from `GET /project/{id}`, `GET /projects` (`idKey` "id") or a search hit (`idKey` "project_id"); null when
 * it doesn't have the expected shape. `author` is only on search hits.
 */
function toProject(raw: unknown, idKey: "id" | "project_id"): ModCatalog.Project | null {
  if (!isRecord(raw)) return null;
  const projectId = matching(raw[idKey], ID_PATTERN);
  const slug = text(raw.slug, 100);
  const title = text(raw.title, 200);
  const description = text(raw.description, 1000);
  const projectType = matching(raw.project_type, TYPE_PATTERN);
  const downloads = count(raw.downloads);
  if (!projectId || !slug || !title || description === null || !projectType || downloads === null) return null;
  return {
    projectId,
    slug,
    title,
    description,
    author: text(raw.author, 100) ?? "",
    iconUrl: httpsUrl(raw.icon_url),
    pageUrl: pageUrl(projectType, slug),
    downloads,
    downloadable: true,
    side: sideOf(raw.server_side, raw.client_side),
  };
}

/**
 * Where a project runs from Modrinth's `server_side` / `client_side` (`required`, `optional`, `unsupported`, `unknown`):
 * server unsupported → client, client unsupported → server, both known otherwise → both; null when Modrinth doesn't say
 * (search hits and older answers may leave the fields out).
 */
function sideOf(server: unknown, client: unknown): ModCatalog.Project["side"] {
  const known = (value: unknown) => value === "required" || value === "optional" || value === "unsupported";
  if (server === "unsupported") return "client";
  if (client === "unsupported") return "server";
  return known(server) && known(client) ? "both" : null;
}

/**
 * A version with its installable file, with its loaders and game versions; null when the shape is wrong or there is
 * no file with both hashes on an allowed host.
 */
function toApiVersion(raw: unknown): { version: ModCatalog.Version; loaders: string[]; gameVersions: string[] } | null {
  if (!isRecord(raw)) return null;
  const versionId = matching(raw.id, ID_PATTERN);
  const projectId = matching(raw.project_id, ID_PATTERN);
  const name = text(raw.name, 200);
  const versionNumber = text(raw.version_number, 100);
  const published = typeof raw.date_published === "string" ? Date.parse(raw.date_published) : NaN;
  if (!versionId || !projectId || name === null || !versionNumber || !Number.isFinite(published)) return null;
  if (!Array.isArray(raw.files) || !Array.isArray(raw.dependencies)) return null;

  const files = raw.files.slice(0, MAX_LIST_ITEMS).filter(isRecord);
  const file = files.find((f) => f.primary === true) ?? files[0];
  if (!file || !isRecord(file.hashes)) return null;
  const sha1 = text(file.hashes.sha1, 64)?.toLowerCase();
  const sha512 = text(file.hashes.sha512, 256)?.toLowerCase();
  const url = httpsUrl(file.url);
  const fileName = text(file.filename, 255);
  const size = count(file.size);
  if (!sha1 || !SHA1_PATTERN.test(sha1) || !sha512 || !SHA512_PATTERN.test(sha512)) return null;
  if (!url || !ModCatalog.fetchAllowed(url) || !fileName || size === null) return null;

  const dependencies = raw.dependencies.slice(0, MAX_LIST_ITEMS).flatMap((dep): ModCatalog.Dependency[] => {
    if (!isRecord(dep)) return [];
    const type = DEPENDENCY_TYPES.find((t) => t === dep.dependency_type);
    if (!type) return [];
    return [{ projectId: matching(dep.project_id, ID_PATTERN), versionId: matching(dep.version_id, ID_PATTERN), type }];
  });

  return {
    version: {
      projectId,
      versionId,
      name,
      versionNumber,
      publishedAt: new Date(published).toISOString(),
      file: { url, name: fileName, size, sha1, sha512, headers: {} },
      dependencies,
    },
    loaders: strings(raw.loaders),
    gameVersions: strings(raw.game_versions),
  };
}

function toVersion(raw: unknown): ModCatalog.Version | null {
  return toApiVersion(raw)?.version ?? null;
}

/**
 * The versions of a `hash → version` map answer, keyed by the hash that was asked for.
 */
function parseHashMap(raw: unknown, hashes: string[]): Map<string, ModCatalog.Version> {
  if (!isRecord(raw)) throw unexpected();
  const result = new Map<string, ModCatalog.Version>();
  for (const hash of hashes) {
    const version = toVersion(raw[hash]);
    if (version) result.set(hash, version);
  }
  return result;
}

/**
 * Newest first by publish date.
 */
function newestFirst(a: ModCatalog.Version, b: ModCatalog.Version): number {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

/**
 * Query parameters narrowing a version list to the context (an empty loader list means any loader).
 */
function contextParams(ctx: ModCatalog.Context): URLSearchParams {
  const params = new URLSearchParams();
  if (ctx.loaders.length > 0) params.set("loaders", JSON.stringify(ctx.loaders));
  params.set("game_versions", JSON.stringify([ctx.gameVersion]));
  return params;
}

async function fetchProjects(projectIds: string[]): Promise<ModCatalog.Project[]> {
  const result: ModCatalog.Project[] = [];
  const missing: string[] = [];
  for (const id of new Set(projectIds)) {
    const cached = projectCache.get(id);
    if (cached) result.push(cached);
    else missing.push(id);
  }
  for (const ids of chunk(missing, BATCH_SIZE)) {
    const params = new URLSearchParams({ ids: JSON.stringify(ids) });
    for (const project of parseList(await request(`/projects?${params}`), (item) => toProject(item, "id"))) {
      projectCache.set(project.projectId, project);
      result.push(project);
    }
  }
  return result;
}

async function fetchVersionsById(versionIds: string[]): Promise<Map<string, ModCatalog.Version>> {
  const result = new Map<string, ModCatalog.Version>();
  for (const ids of chunk([...new Set(versionIds)], BATCH_SIZE)) {
    const params = new URLSearchParams({ ids: JSON.stringify(ids) });
    for (const version of parseList(await request(`/versions?${params}`), toVersion)) result.set(version.versionId, version);
  }
  return result;
}
//#endregion

/**
 * Modrinth as a mod catalog.
 */
export const Modrinth: ModCatalog = {
  label: "Modrinth",

  /**
   * Modrinth needs no credentials.
   */
  unavailable() {
    return null;
  },

  /**
   * `GET /search` with facets for project type, loaders, game version and server-side support.
   */
  search(ctx, query, offset, limit) {
    return guard(async () => {
      const facets: string[][] = [
        [`project_type:${ctx.projectType}`],
        ctx.loaders.map((loader) => `categories:${loader}`),
        [`versions:${ctx.gameVersion}`],
        ["server_side:required", "server_side:optional"],
      ].filter((group) => group.length > 0);
      const params = new URLSearchParams({
        query,
        offset: String(Math.max(0, Math.floor(offset))),
        limit: String(Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))),
        index: query.trim() === "" ? "downloads" : "relevance",
        facets: JSON.stringify(facets),
      });
      const body = await request(`/search?${params}`);
      if (!isRecord(body)) throw unexpected();
      return {
        hits: parseList(body.hits, (hit) => toProject(hit, "project_id")),
        total: count(body.total_hits) ?? 0,
      };
    });
  },

  /**
   * `GET /project/{id}` (cached 5 minutes). `author` is empty: it would take a team lookup per project.
   */
  project(_ctx, projectId) {
    return guard(async () => {
      const cached = projectCache.get(projectId);
      if (cached) return cached;
      const raw = await request(`/project/${encodeURIComponent(projectId)}`, {}, `Modrinth has no project "${projectId}".`);
      const project = toProject(raw, "id");
      if (!project) throw unexpected();
      projectCache.set(projectId, project);
      projectCache.set(project.projectId, project);
      return project;
    });
  },

  /**
   * `GET /projects?ids=[...]` in batches of 100 for the ids not cached; unknown ids are left out.
   */
  projects(_ctx, projectIds) {
    return guard(() => fetchProjects(projectIds));
  },

  /**
   * `GET /project/{id}/version?loaders=[...]&game_versions=["v"]` (cached 5 minutes), newest first.
   */
  versions(ctx, projectId, limit) {
    return guard(async () => {
      const key = `${projectId}|${ctx.loaders.join(",")}|${ctx.gameVersion}`;
      let versions = versionsCache.get(key);
      if (!versions) {
        const raw = await request(`/project/${encodeURIComponent(projectId)}/version?${contextParams(ctx)}`, {}, `Modrinth has no project "${projectId}".`);
        versions = parseList(raw, toVersion).sort(newestFirst);
        versionsCache.set(key, versions);
      }
      return versions.slice(0, Math.max(0, limit));
    });
  },

  /**
   * `GET /version/{id}`; `compatible` when a loader (any, when the context has none) and the game version match.
   */
  version(ctx, versionId) {
    return guard(async () => {
      const raw = await request(`/version/${encodeURIComponent(versionId)}`, {}, `Modrinth has no version "${versionId}".`);
      const parsed = toApiVersion(raw);
      if (!parsed) throw new HttpError(502, `Modrinth version "${versionId}" has no downloadable file the panel can verify.`);
      const compatible = (ctx.loaders.length === 0 || parsed.loaders.some((loader) => ctx.loaders.includes(loader))) && parsed.gameVersions.includes(ctx.gameVersion);
      return { version: parsed.version, compatible };
    });
  },

  /**
   * `GET /versions?ids=[...]` in batches of 100; unknown ids are left out.
   */
  versionsById(_ctx, versionIds) {
    return guard(() => fetchVersionsById(versionIds));
  },

  /**
   * `POST /version_files/update` with the installed files' SHA-1s (looked up with `GET /versions?ids=` for installs
   * that don't have one recorded), in batches of 100. Keyed by the installed version id.
   */
  updates(ctx, installed) {
    return guard(async () => {
      const updates = new Map<string, ModCatalog.Version>();
      const withoutHash = installed.filter((item) => !item.sha1).map((item) => item.versionId);
      const looked = withoutHash.length > 0 ? await fetchVersionsById(withoutHash) : new Map<string, ModCatalog.Version>();

      const byHash = new Map<string, ModCatalog.Installed[]>();
      for (const item of installed) {
        const sha1 = (item.sha1 ?? looked.get(item.versionId)?.file.sha1)?.toLowerCase();
        if (!sha1 || !SHA1_PATTERN.test(sha1)) continue;
        byHash.set(sha1, [...byHash.get(sha1) ?? [], item]);
      }

      for (const hashes of chunk([...byHash.keys()], BATCH_SIZE)) {
        const body: Json = { hashes, algorithm: "sha1", game_versions: [ctx.gameVersion] };
        if (ctx.loaders.length > 0) body.loaders = ctx.loaders;
        const latest = parseHashMap(await post("/version_files/update", body), hashes);
        for (const [hash, version] of latest) {
          for (const item of byHash.get(hash) ?? []) {
            if (version.versionId !== item.versionId) updates.set(item.versionId, version);
          }
        }
      }
      return updates;
    });
  },

  /**
   * `POST /version_files` (hash to version) plus the projects batch; files Modrinth doesn't know are absent.
   */
  identify(_ctx, sha1s) {
    return guard(async () => {
      const result = new Map<string, { project: ModCatalog.Project; version: ModCatalog.Version }>();
      const hashes = [...new Set(sha1s.map((hash) => hash.toLowerCase()).filter((hash) => SHA1_PATTERN.test(hash)))];
      const found = new Map<string, ModCatalog.Version>();
      for (const group of chunk(hashes, BATCH_SIZE)) {
        for (const [hash, version] of parseHashMap(await post("/version_files", { hashes: group, algorithm: "sha1" }), group)) found.set(hash, version);
      }
      const projects = new Map((await fetchProjects([...found.values()].map((version) => version.projectId))).map((project) => [project.projectId, project]));
      for (const [hash, version] of found) {
        const project = projects.get(version.projectId);
        if (project) result.set(hash, { project, version });
      }
      return result;
    });
  },
};

export default Modrinth;
