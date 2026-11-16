/**
 * CurseForge (official Core API v1, `https://api.curseforge.com`) implementation of `ModCatalog`. Authenticated with the
 * operator's own API key from the context (`x-api-key`); no other key, proxy or website route is ever used. Only talks to
 * hosts allowed by `ModCatalog.fetchAllowed`, and validates every answer: items that don't have the expected shape are
 * dropped, an answer that isn't the expected kind of JSON at all becomes a 502.
 *
 * Terms of use honoured: mods whose author disallows distribution (`allowModDistribution: false`) are `downloadable:
 * false`, files without a `downloadUrl` are never returned, project links point at CurseForge, and results are cached
 * only briefly.
 */
import { HttpError } from "../../lib/HttpError.ts";
import { AppSystem } from "../../AppSystem.ts";
import { ModCatalog } from "../ModCatalog.ts";

//#region Constants
const API_URL = "https://api.curseforge.com";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_PAGE = 50; // CurseForge's `pageSize` limit
const MAX_SEARCH_WINDOW = 10_000; // `index + pageSize` limit
const FILES_PAGE_SIZE = 50;
const MAX_FILE_PAGES = 4; // Pages of a mod's files read when listing versions (200 files)
const BATCH_SIZE = 50; // Ids per `POST /v1/mods` and `POST /v1/mods/files`
const UPDATE_CONCURRENCY = 4;
const MAX_LIST_ITEMS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CLASSES_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const USER_AGENT = `ionnet-gss/${AppSystem.version} (game server panel)`;
const NEEDS_KEY = "An administrator needs to add a CurseForge API key under Settings → Mod catalogs.";
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

/**
 * `ModsSearchSortField` values used.
 */
const SORT_TOTAL_DOWNLOADS = 6;
const SORT_RELEVANCY = 13;

/**
 * `ModLoaderType` by the loader names the panel uses.
 */
const LOADER_TYPES: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

/**
 * Files in these `FileStatus` values are published: 4 Approved, 10 Released.
 */
const PUBLISHED_STATUSES = [4, 10];

/**
 * `FileRelationType` to the panel's dependency types. 4 (Tool) isn't a dependency of the game server.
 */
const RELATION_TYPES: Record<number, ModCatalog.Dependency["type"]> = {
  1: "embedded",
  2: "optional",
  3: "required",
  5: "incompatible",
  6: "embedded",
};
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
 * A non-negative finite number, or null.
 */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A positive safe integer (CurseForge ids), or null.
 */
function id(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
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
  return new HttpError(502, "CurseForge answered with something unexpected.");
}

/**
 * Requires an array and maps its items with `parse`, dropping those that return null.
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
    console.error("CurseForge answer couldn't be processed:", error);
    throw unexpected();
  }
}
//#endregion

/**
 * A small in-memory cache whose entries expire after `ttl` ms; the oldest entry goes when it is full.
 */
class TtlCache<T> {
  private readonly _entries = new Map<string, { value: T; expires: number }>();

  constructor(private readonly _ttl: number) { }

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
    this._entries.set(key, { value, expires: Date.now() + this._ttl });
    if (this._entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this._entries.keys().next().value;
      if (oldest !== undefined) this._entries.delete(oldest);
    }
  }
}

const _refusals = new WeakSet<HttpError>();

/**
 * Whether `error` is CurseForge refusing the API key (401/403), as opposed to CurseForge being down or rate limiting.
 */
export function isKeyRefusal(error: unknown): boolean {
  return error instanceof HttpError && _refusals.has(error);
}

/**
 * The version with the context's key as the download header (CurseForge's CDN wants it). Cached versions never hold
 * the key, so a rotated key is used at once and nothing cached can leak it.
 */
function keyed(ctx: ModCatalog.Context, version: ModCatalog.Version): ModCatalog.Version {
  return { ...version, file: { ...version.file, headers: ctx.apiKey ? { "x-api-key": ctx.apiKey } : {} } };
}

// Keys start with a short hash of the API key, so another key never reads (or sees) an entry cached for this one.
const projectCache = new TtlCache<ModCatalog.Project>(CACHE_TTL_MS);
const versionsCache = new TtlCache<ModCatalog.Version[]>(CACHE_TTL_MS);
const classesCache = new TtlCache<{ id: number; slug: string }[]>(CLASSES_TTL_MS);

/**
 * First 8 hex characters of the SHA-256 of the context's key, for cache keys.
 */
async function keyTag(ctx: ModCatalog.Context): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ctx.apiKey ?? ""));
  return [...new Uint8Array(digest).slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

//#region HTTP
/**
 * Reads a response body as JSON, refusing anything over `MAX_BODY_BYTES` (by `Content-Length` and while streaming).
 */
async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new HttpError(502, "CurseForge's answer is too large.");
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
      throw new HttpError(502, "CurseForge's answer is too large.");
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
    throw new HttpError(502, "CurseForge answered with something that isn't JSON.");
  }
}

/**
 * Calls the CurseForge API with the context's key and returns the `data` and `pagination` of the answer (unvalidated).
 * Errors become `HttpError`: 409 when there is no key or it is refused (401/403), 429 when rate limited, `notFound`
 * (when given) for a 404, 502 for everything else.
 * @param path Path below the API root, including the query string.
 * @param notFound Message for a 404; without it a 404 is a 502 like any other bad status.
 */
async function request(ctx: ModCatalog.Context, path: string, init: RequestInit = {}, notFound?: string): Promise<{ data: unknown; pagination: unknown }> {
  if (!ctx.apiKey) throw new HttpError(409, NEEDS_KEY);
  const url = `${API_URL}${path}`;
  if (!ModCatalog.fetchAllowed(url)) throw new HttpError(502, "The panel isn't allowed to contact CurseForge. Add api.curseforge.com to MOD_CATALOG_HOSTS.");

  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", "application/json");
  headers.set("x-api-key", ctx.apiKey);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new HttpError(502, `CurseForge didn't answer: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new HttpError(502, `CurseForge answered with a redirect (${res.status}), which the panel doesn't follow.`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      const refusal = new HttpError(409, "CurseForge refused the API key; check it under Settings → Mod catalogs.");
      _refusals.add(refusal);
      throw refusal;
    }
    if (res.status === 404 && notFound !== undefined) {
      await res.body?.cancel();
      throw HttpError.notFound(notFound);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("retry-after"));
      throw HttpError.tooManyRequests("CurseForge is rate limiting the panel; try again in a minute.", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(502, `CurseForge answered ${res.status} ${res.statusText}`.trim());
    }
    const body = await readJson(res);
    if (!isRecord(body) || !("data" in body)) throw unexpected();
    return { data: body.data, pagination: body.pagination };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `CurseForge didn't answer: ${error instanceof Error ? error.message : String(error)}`);
  }
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

/**
 * The CurseForge `ModLoaderType`s of loader names (case-insensitive); an unknown name is a 409 naming it.
 */
function loaderTypes(loaders: string[]): number[] {
  return loaders.map((loader) => {
    const type = LOADER_TYPES[loader.toLowerCase()];
    if (type === undefined) throw new HttpError(409, `CurseForge doesn't know the mod loader "${loader}".`);
    return type;
  });
}

/**
 * The loader filter for a search or file list: `modLoaderType` for one loader (it needs `gameVersion`, always set),
 * `modLoaderTypes` for several (at most 5), nothing for any loader.
 */
function loaderParams(params: URLSearchParams, loaders: string[]): void {
  const types = loaderTypes(loaders);
  if (types.length === 1) params.set("modLoaderType", String(types[0]));
  else if (types.length > 1) params.set("modLoaderTypes", `[${types.slice(0, 5).join(",")}]`);
}

/**
 * A project from `GET /v1/mods/{id}`, `POST /v1/mods` or a search; null when it doesn't have the expected shape.
 */
function toProject(raw: unknown): ModCatalog.Project | null {
  if (!isRecord(raw)) return null;
  const modId = id(raw.id);
  const slug = text(raw.slug, 100);
  const title = text(raw.name, 200);
  const description = text(raw.summary, 1000);
  const downloads = count(raw.downloadCount);
  if (!modId || !slug || !title || description === null || downloads === null) return null;
  const logo = isRecord(raw.logo) ? raw.logo : {};
  const authors = Array.isArray(raw.authors) ? raw.authors : [];
  const firstAuthor = authors.find(isRecord);
  const links = isRecord(raw.links) ? raw.links : {};
  return {
    projectId: String(modId),
    slug,
    title,
    description,
    author: firstAuthor ? text(firstAuthor.name, 100) ?? "" : "",
    iconUrl: httpsUrl(logo.thumbnailUrl) ?? httpsUrl(logo.url),
    pageUrl: httpsUrl(links.websiteUrl) ?? `https://www.curseforge.com/projects/${modId}`,
    downloads,
    downloadable: raw.allowModDistribution !== false, // null (unset) is treated as allowed; the file's `downloadUrl` is the real gate
    side: null, // CurseForge doesn't say where a mod runs.
  };
}

/**
 * Whether `hostname` is on CurseForge's CDN (the only place the API key may be sent with a download).
 */
function isCurseForgeCdn(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === "forgecdn.net" || host.endsWith(".forgecdn.net");
}

/**
 * A downloadable version of a CurseForge file, with the game versions (and loader names) it lists; null when the
 * shape is wrong, it isn't published, or it can't be downloaded (no `downloadUrl`, no SHA-1, a URL off CurseForge's CDN).
 */
function toApiFile(ctx: ModCatalog.Context, raw: unknown): { version: ModCatalog.Version; gameVersions: string[] } | null {
  if (!isRecord(raw)) return null;
  const fileId = id(raw.id);
  const modId = id(raw.modId);
  const displayName = text(raw.displayName, 200);
  const fileName = text(raw.fileName, 255);
  const published = typeof raw.fileDate === "string" ? Date.parse(raw.fileDate) : NaN;
  const size = count(raw.fileLength);
  if (!fileId || !modId || displayName === null || !fileName || !Number.isFinite(published) || size === null) return null;
  if (typeof raw.fileStatus !== "number" || !PUBLISHED_STATUSES.includes(raw.fileStatus)) return null;
  if (raw.isAvailable === false) return null;

  const url = httpsUrl(raw.downloadUrl);
  if (!url || !ModCatalog.fetchAllowed(url) || !isCurseForgeCdn(url) || !ctx.apiKey) return null;

  if (!Array.isArray(raw.hashes)) return null;
  const sha1Entry = raw.hashes.slice(0, 20).find((hash) => isRecord(hash) && hash.algo === 1);
  const sha1 = isRecord(sha1Entry) ? text(sha1Entry.value, 64)?.toLowerCase() : null;
  if (!sha1 || !SHA1_PATTERN.test(sha1)) return null;

  const dependencies = (Array.isArray(raw.dependencies) ? raw.dependencies : []).slice(0, MAX_LIST_ITEMS).flatMap((dep): ModCatalog.Dependency[] => {
    if (!isRecord(dep) || typeof dep.relationType !== "number") return [];
    const depId = id(dep.modId);
    const type = RELATION_TYPES[dep.relationType];
    return depId && type ? [{ projectId: String(depId), versionId: null, type }] : [];
  });

  return {
    version: {
      projectId: String(modId),
      versionId: String(fileId),
      name: displayName,
      versionNumber: displayName.slice(0, 100),
      publishedAt: new Date(published).toISOString(),
      file: { url, name: fileName, size, sha1, sha512: null, headers: {} }, // Key-free: `keyed()` adds it on the way out.
      dependencies,
    },
    gameVersions: strings(raw.gameVersions),
  };
}

/**
 * Whether a file's game versions (which also list loader names such as "NeoForge") fit the context.
 */
function fitsContext(ctx: ModCatalog.Context, gameVersions: string[]): boolean {
  if (!gameVersions.includes(ctx.gameVersion)) return false;
  if (ctx.loaders.length === 0) return true;
  const wanted = ctx.loaders.map((loader) => loader.toLowerCase());
  return gameVersions.some((name) => wanted.includes(name.toLowerCase()));
}

/**
 * Newest first by file date.
 */
function newestFirst(a: ModCatalog.Version, b: ModCatalog.Version): number {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

/**
 * The numeric id of a project or version id string, or null when it isn't one.
 */
function numericId(value: string): number | null {
  return /^[0-9]{1,15}$/.test(value) ? Number(value) : null;
}

/**
 * The game's top-level sections (classes), cached for an hour: the section id of a `project_type` slug is in here.
 */
async function classId(ctx: ModCatalog.Context): Promise<number> {
  if (ctx.gameId === null) throw new HttpError(409, "CurseForge needs a game id for this catalog.");
  const key = `${await keyTag(ctx)}|${ctx.gameId}`;
  let classes = classesCache.get(key);
  if (!classes) {
    const { data } = await request(ctx, `/v1/categories?${new URLSearchParams({ gameId: String(ctx.gameId), classesOnly: "true" })}`);
    classes = parseList(data, (item) => {
      if (!isRecord(item)) return null;
      const classId = id(item.id);
      const slug = text(item.slug, 100);
      return classId && slug ? { id: classId, slug } : null;
    });
    classesCache.set(key, classes);
  }
  const found = classes.find((item) => item.slug === ctx.projectType);
  if (!found) throw new HttpError(409, `CurseForge has no "${ctx.projectType}" section for this game.`);
  return found.id;
}

/**
 * Downloadable versions for file ids via `POST /v1/mods/files`, in batches; unknown or undownloadable ids are left out.
 */
async function fetchFiles(ctx: ModCatalog.Context, versionIds: string[]): Promise<{ version: ModCatalog.Version; gameVersions: string[] }[]> {
  const ids = [...new Set(versionIds.flatMap((versionId) => numericId(versionId) ?? []))];
  const result: { version: ModCatalog.Version; gameVersions: string[] }[] = [];
  for (const group of chunk(ids, BATCH_SIZE)) {
    const { data } = await request(ctx, "/v1/mods/files", { method: "POST", body: JSON.stringify({ fileIds: group }) });
    result.push(...parseList(data, (item) => toApiFile(ctx, item)));
  }
  return result;
}
//#endregion

/**
 * CurseForge as a mod catalog.
 */
export const CurseForge: ModCatalog = {
  label: "CurseForge",

  /**
   * Needs the operator's API key.
   */
  unavailable(ctx) {
    return ctx.apiKey ? null : NEEDS_KEY;
  },

  /**
   * `GET /v1/mods/search` filtered by game, section (class), game version and loaders; most downloaded first for an
   * empty query, by relevancy otherwise. CurseForge only pages within the first 10,000 results.
   */
  search(ctx, query, offset, limit) {
    return guard(async () => {
      const index = Math.max(0, Math.floor(offset));
      const pageSize = Math.min(MAX_SEARCH_PAGE, Math.max(1, Math.floor(limit)));
      if (index + pageSize > MAX_SEARCH_WINDOW) return { hits: [], total: 0 };
      const params = new URLSearchParams({
        gameId: String(ctx.gameId ?? ""),
        classId: String(await classId(ctx)),
        gameVersion: ctx.gameVersion,
        sortField: String(query.trim() === "" ? SORT_TOTAL_DOWNLOADS : SORT_RELEVANCY),
        sortOrder: "desc",
        index: String(index),
        pageSize: String(pageSize),
      });
      if (query.trim() !== "") params.set("searchFilter", query.trim());
      loaderParams(params, ctx.loaders);
      const { data, pagination } = await request(ctx, `/v1/mods/search?${params}`);
      const total = isRecord(pagination) ? count(pagination.totalCount) : null;
      return { hits: parseList(data, toProject), total: Math.min(total ?? 0, MAX_SEARCH_WINDOW) };
    });
  },

  /**
   * `GET /v1/mods/{id}` (cached 5 minutes).
   */
  project(ctx, projectId) {
    return guard(async () => {
      const modId = numericId(projectId);
      if (modId === null) throw HttpError.notFound(`CurseForge has no project "${projectId}".`);
      const key = `${await keyTag(ctx)}|${modId}`;
      const cached = projectCache.get(key);
      if (cached) return cached;
      const { data } = await request(ctx, `/v1/mods/${modId}`, {}, `CurseForge has no project "${projectId}".`);
      const project = toProject(data);
      if (!project) throw unexpected();
      projectCache.set(key, project);
      return project;
    });
  },

  /**
   * `POST /v1/mods` with the ids not cached, in batches of 50; unknown ids are left out.
   */
  projects(ctx, projectIds) {
    return guard(async () => {
      const tag = await keyTag(ctx);
      const result: ModCatalog.Project[] = [];
      const missing: number[] = [];
      for (const projectId of new Set(projectIds)) {
        const modId = numericId(projectId);
        if (modId === null) continue;
        const cached = projectCache.get(`${tag}|${modId}`);
        if (cached) result.push(cached);
        else missing.push(modId);
      }
      for (const group of chunk(missing, BATCH_SIZE)) {
        const { data } = await request(ctx, "/v1/mods", { method: "POST", body: JSON.stringify({ modIds: group }) });
        for (const project of parseList(data, toProject)) {
          projectCache.set(`${tag}|${project.projectId}`, project);
          if (!result.some((known) => known.projectId === project.projectId)) result.push(project);
        }
      }
      return result;
    });
  },

  /**
   * `GET /v1/mods/{id}/files` for the game version (and the loader, when there is exactly one), up to 4 pages of 50,
   * then filtered to the context and sorted newest first here (cached 5 minutes). Files without a download URL are left out.
   */
  versions(ctx, projectId, limit) {
    return guard(async () => {
      const modId = numericId(projectId);
      if (modId === null) throw HttpError.notFound(`CurseForge has no project "${projectId}".`);
      const key = `${await keyTag(ctx)}|${modId}|${ctx.loaders.join(",")}|${ctx.gameVersion}`;
      let versions = versionsCache.get(key);
      if (!versions) {
        versions = [];
        for (let page = 0; page < MAX_FILE_PAGES; page++) {
          const params = new URLSearchParams({ gameVersion: ctx.gameVersion, index: String(page * FILES_PAGE_SIZE), pageSize: String(FILES_PAGE_SIZE) });
          loaderParams(params, ctx.loaders.length === 1 ? ctx.loaders : []);
          const { data, pagination } = await request(ctx, `/v1/mods/${modId}/files?${params}`, {}, `CurseForge has no project "${projectId}".`);
          for (const file of parseList(data, (item) => toApiFile(ctx, item))) {
            if (fitsContext(ctx, file.gameVersions)) versions.push(file.version);
          }
          const total = isRecord(pagination) ? count(pagination.totalCount) : null;
          if (total === null || (page + 1) * FILES_PAGE_SIZE >= total) break;
        }
        versions.sort(newestFirst);
        versionsCache.set(key, versions);
      }
      return versions.slice(0, Math.max(0, limit)).map((version) => keyed(ctx, version));
    });
  },

  /**
   * `POST /v1/mods/files` with the one file id; `compatible` when it fits the context's game version and loaders.
   * A file the author doesn't allow third parties to download is a 409.
   */
  version(ctx, versionId) {
    return guard(async () => {
      const fileId = numericId(versionId);
      if (fileId === null) throw HttpError.notFound(`CurseForge has no file "${versionId}".`);
      const { data } = await request(ctx, "/v1/mods/files", { method: "POST", body: JSON.stringify({ fileIds: [fileId] }) });
      if (!Array.isArray(data)) throw unexpected();
      if (data.length === 0) throw HttpError.notFound(`CurseForge has no file "${versionId}".`);
      const file = toApiFile(ctx, data[0]);
      if (!file) throw new HttpError(409, `CurseForge file "${versionId}" can't be downloaded by the panel (its author doesn't allow downloads outside CurseForge, or the file isn't published).`);
      return { version: keyed(ctx, file.version), compatible: fitsContext(ctx, file.gameVersions) };
    });
  },

  /**
   * `POST /v1/mods/files` in batches of 50; unknown ids and files that can't be downloaded are left out.
   */
  versionsById(ctx, versionIds) {
    return guard(async () => {
      const result = new Map<string, ModCatalog.Version>();
      for (const file of await fetchFiles(ctx, versionIds)) result.set(file.version.versionId, keyed(ctx, file.version));
      return result;
    });
  },

  /**
   * For each installed project, its newest compatible file (see `versions`) when it isn't the installed one. Projects
   * CurseForge no longer has are skipped. Keyed by the installed version id.
   */
  updates(ctx, installed) {
    return guard(async () => {
      const updates = new Map<string, ModCatalog.Version>();
      const projectIds = [...new Set(installed.map((item) => item.projectId))];
      for (const group of chunk(projectIds, UPDATE_CONCURRENCY)) {
        const newest = await Promise.all(group.map(async (projectId) => {
          try {
            return (await CurseForge.versions(ctx, projectId, 1))[0] ?? null;
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) return null;
            throw error;
          }
        }));
        group.forEach((projectId, i) => {
          const version = newest[i];
          if (!version) return;
          for (const item of installed) {
            if (item.projectId === projectId && item.versionId !== version.versionId) updates.set(item.versionId, version);
          }
        });
      }
      return updates;
    });
  },
};

export default CurseForge;
