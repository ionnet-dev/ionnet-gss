/**
 * What `ModService` (the Mods tab) and `ModPackService` (pack import) share: opening a server's mod folders, catalog
 * contexts with the operator's keys, folder listings, the per-server mod lock, the manifest `gss-mods.json`, upload
 * recognition and the rate limits.
 *
 * The manifest (data root, so it travels with backups; the agent refuses uploads into `.gss/`) holds what the panel
 * knows about entries it put there: `{ version: 1, folders: { <key>: { <entry name>: ManifestEntry } } }`. A catalog
 * install or a recognised upload has `provider`, ids and titles; an unrecognised upload only its name and SHA-1. A
 * missing or unreadable manifest counts as empty; what is read from disk is checked field by field (prototype-free
 * maps, SHA-1 shape, links only to catalog hosts, capped lengths). Entries whose mod is gone are dropped whenever it
 * is written.
 */
import type { FileEntryDto } from "@shared/api/files.ts";
import {
  type GameDefinition,
  MOD_CATALOG_PROVIDER_VALUES,
  type ModCatalogProvider,
  type ModCatalogRef,
  type ModFolder,
} from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { DefinitionEngine } from "../definitions/DefinitionEngine.ts";
import { ModFolders } from "../definitions/ModFolders.ts";
import { HttpError } from "../lib/HttpError.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import { AgentGateway } from "../gateways/agent/AgentGateway.ts";
import { GameServer, type User } from "../models/index.ts";
import { ModCatalog } from "../mods/ModCatalog.ts";
import { FileService } from "./FileService.ts";
import { GameVersion } from "./GameVersion.ts";
import { ModCatalogKeys } from "./ModCatalogKeys.ts";
import { ServerAccess } from "./ServerAccess.ts";

export namespace ModStore {
  /**
   * The manifest's path below the data folder.
   */
  export const MANIFEST_PATH = "gss-mods.json";
  /**
   * How long recognising one upload or pack file by its SHA-1 may take before it is recorded as unknown.
   */
  export const IDENTIFY_TIMEOUT_MS = 5000;
  /**
   * Hosts manifest links (icons, pages) may point to besides MOD_CATALOG_HOSTS.
   */
  export const LINK_HOSTS: readonly string[] = ["modrinth.com", "www.curseforge.com", "media.forgecdn.net"];
  export const UNKNOWN_VERSION = "The game version isn't known yet. Install or start the server once, then try again.";

  /**
   * Catalog searches and version lists per user and minute.
   */
  export const catalogLimiter = new RateLimiter(60, 60, "catalog searches");
  /**
   * Installs, updates and pack imports per user and minute.
   */
  export const installLimiter = new RateLimiter(10, 60, "mod installs");

  /**
   * Temporary upload names (`.<name>.gss-upload-<8 hex>` or `.gss-upload-<8 hex>`).
   */
  export const UPLOAD_TEMP = /^\.(?:.+\.)?gss-upload-[0-9a-f]{8}$/;
  /**
   * How old an upload leftover must be before the sweep removes it (a running upload keeps its file fresh).
   */
  export const UPLOAD_LEFTOVER_MS = 60 * 60 * 1000;
  const MAX_TEXT = 256;
  const MAX_ID = 100;
  const MAX_URL = 2048;
  const MAX_REQUIRED_BY = 50;
  const SHA1 = /^[0-9a-f]{40}$/;

  //#region Types
  /**
   * What the panel knows about one entry name in one folder. `provider` null = an upload no catalog recognised.
   */
  export interface ManifestEntry {
    provider: ModCatalogProvider | null;
    projectId: string | null;
    versionId: string | null;
    title: string;
    versionNumber: string | null;
    iconUrl: string | null;
    pageUrl: string | null;
    installedAt: string;
    sha1: string;
    requiredBy: string[]; // Titles of the mods that pulled this one in; empty for a direct install.
  }

  export interface Manifest {
    version: 1;
    folders: Record<string, Record<string, ManifestEntry>>; // Both levels prototype-free.
  }

  export interface LoadedManifest {
    manifest: Manifest;
    modifiedAt: string | null; // null = not there (or unreadable): written unchecked.
  }

  /**
   * The server with its definition and the mod folders that apply to it.
   */
  export interface Opened {
    server: GameServer;
    def: GameDefinition;
    values: Record<string, DefinitionEngine.Value>;
    folders: ModFolder[];
  }

  /**
   * One catalog of one folder, with the context it is asked with.
   */
  export interface CatalogRef {
    ref: ModCatalogRef;
    catalog: ModCatalog;
    ctx: ModCatalog.Context;
    unavailable: string | null; // Why it can't be used, or null.
  }

  export interface CatalogOpened extends Opened {
    folder: ModFolder;
    ref: ModCatalogRef;
    catalog: ModCatalog;
    ctx: ModCatalog.Context;
  }

  /**
   * One listed folder (every entry, not only mods, so name clashes are visible).
   */
  export interface Listing {
    path: string;
    exists: boolean;
    truncated: boolean;
    entries: FileEntryDto[];
  }

  export interface Scan {
    folder: ModFolder;
    enabled: Listing;
    disabled: Listing;
  }

  export interface ListedMod {
    entry: FileEntryDto;
    enabled: boolean;
  }

  /**
   * A file a catalog recognised: its manifest entry, where the project runs, and the catalog's label.
   */
  export interface Identified {
    entry: ManifestEntry;
    side: ModCatalog.Project["side"];
    label: string;
  }
  //#endregion

  const _locks = new Map<string, Promise<void>>();

  //#region Server and catalogs
  /**
   * The server (`manage` access) with the mod folders that apply.
   * @throws HttpError 404 without access or when no folder applies.
   */
  export async function open(user: User, serverId: string): Promise<Opened> {
    const server = await ServerAccess.get(user, serverId, "manage", { include: [{ association: "definition" }] });
    const def = server.definition?.document;
    const values = server.variables ?? {};
    const folders = def === undefined ? [] : ModFolders.applicable(def, values);
    if (def === undefined || folders.length === 0) throw HttpError.notFound("This server's game has no mod folders.");
    return { server, def, values, folders };
  }

  /**
   * @throws HttpError 404 when `key` isn't one of the server's applicable folders.
   */
  export function folderOf(opened: Opened, key: string): ModFolder {
    const folder = opened.folders.find((candidate) => candidate.key === key);
    if (!folder) throw HttpError.notFound(`This server has no mod folder "${key}". Its folders: ${opened.folders.map((f) => f.key).join(", ")}.`);
    return folder;
  }

  export function version(user: User, opened: Opened): Promise<string | null> {
    return GameVersion.of(user, opened.server, opened.def, opened.values);
  }

  /**
   * Every catalog of the folder with its context (the operator's key included) and whether it can be used.
   * @param gameVersion The server's version, or null (the context then carries "").
   */
  export async function catalogsOf(opened: Opened, folder: ModFolder, gameVersion: string | null): Promise<CatalogRef[]> {
    const refs: CatalogRef[] = [];
    for (const ref of folder.catalogs ?? []) {
      const catalog = ModCatalog.CATALOGS[ref.provider];
      const loaders = ModFolders.loaders(ref, opened.values);
      const ctx: ModCatalog.Context = {
        projectType: ref.project_type,
        loaders,
        gameVersion: gameVersion ?? "",
        gameId: ref.game_id ?? null,
        apiKey: null,
      };
      const key = await ModCatalogKeys.keyState(ref.provider);
      ctx.apiKey = key.key;
      let unavailable: string | null = null;
      if (key.unreadable) { // A stored key that is unusable: say so instead of "add a key".
        unavailable = ModCatalogKeys.UNREADABLE;
      }
      else if ((ref.loaders ?? []).length > 0 && loaders.length === 0) {
        unavailable = `${catalog.label} has no loader for this server's settings. Check the game definition's catalogs[].loaders.`;
      }
      else if (ref.provider === "curseforge" && loaders.some((loader) => !DefinitionEngine.CURSEFORGE_LOADERS.includes(loader))) {
        unavailable = `CurseForge doesn't know the loader ${loaders.filter((loader) => !DefinitionEngine.CURSEFORGE_LOADERS.includes(loader)).join(", ")} this server runs.`;
      }
      unavailable ??= catalog.unavailable(ctx);
      refs.push({ ref, catalog, ctx, unavailable });
    }
    return refs;
  }

  /**
   * One usable catalog of a folder.
   * @throws HttpError 400 for an unknown provider, 404 when the folder has no such catalog, 409 when it is unavailable
   * or the game version is unknown.
   */
  export async function openCatalog(user: User, serverId: string, key: string, provider: unknown): Promise<CatalogOpened> {
    if (!MOD_CATALOG_PROVIDER_VALUES.includes(provider as ModCatalogProvider)) {
      throw HttpError.badRequest(`"provider" must be one of: ${MOD_CATALOG_PROVIDER_VALUES.join(", ")}.`);
    }
    const opened = await open(user, serverId);
    const folder = folderOf(opened, key);
    const gameVersion = await version(user, opened);
    const found = (await catalogsOf(opened, folder, gameVersion)).find((candidate) => candidate.ref.provider === provider);
    if (!found) throw HttpError.notFound(`${labelOf(folder)} can't be installed into from ${provider}.`);
    if (found.unavailable !== null) throw HttpError.conflict(found.unavailable);
    if (gameVersion === null) throw HttpError.conflict(UNKNOWN_VERSION);
    return { ...opened, folder, ref: found.ref, catalog: found.catalog, ctx: found.ctx };
  }

  export function labelOf(folder: ModFolder): string {
    return folder.label ?? folder.key;
  }

  /**
   * Whether a file of this name may land in the folder: a plain name matching a file pattern.
   */
  export function fitsFolder(folder: ModFolder, fileName: string): boolean {
    return ModFolders.isFileName(fileName) && ModFolders.matches(ModFolders.filePatterns(folder), fileName, false);
  }
  //#endregion

  //#region Folders
  /**
   * Both folders of a mod folder; a missing one is empty.
   */
  export async function scan(user: User, serverId: string, folder: ModFolder): Promise<Scan> {
    const [enabled, disabled] = await Promise.all([list(user, serverId, folder.folder), list(user, serverId, ModFolders.disabledFolder(folder))]);
    return { folder, enabled, disabled };
  }

  export async function list(user: User, serverId: string, path: string): Promise<Listing> {
    try {
      const res = await FileService.list(user, serverId, path);
      return { path, exists: true, truncated: res.truncated, entries: res.entries };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { path, exists: false, truncated: false, entries: [] };
      throw error;
    }
  }

  /**
   * The entries that are mods: enabled first, then disabled, each by name (case-insensitive).
   */
  export function modsOf(folderScan: Scan): ListedMod[] {
    const pick = (listing: Listing, enabled: boolean): ListedMod[] => listing.entries
      .filter((entry) => ModFolders.matches(folderScan.folder.match, entry.name, entry.type === "dir"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({ entry, enabled }));
    return [...pick(folderScan.enabled, true), ...pick(folderScan.disabled, false)];
  }

  /**
   * Create a folder and its parents; existing ones are fine (the agent's `mkdir` makes one level and refuses an
   * existing entry with a 409; a file in the way then fails the next step with the agent's message).
   */
  export async function ensureFolder(user: User, serverId: string, path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      try {
        await FileService.mkdir(user, serverId, parts.slice(0, i).join("/"));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
      }
    }
  }

  /**
   * Remove upload leftovers (`ModService`'s temporary names, a panel that died mid-upload) older than
   * UPLOAD_LEFTOVER_MS from both folders of a scan. Best effort; call it under the lock.
   * @param keep A temporary path in use by the caller, never removed.
   */
  export async function sweepUploads(user: User, serverId: string, folderScan: Scan, keep?: string): Promise<void> {
    const cutoff = Date.now() - UPLOAD_LEFTOVER_MS;
    const stale = [folderScan.enabled, folderScan.disabled].flatMap((listing) => listing.entries
      .filter((entry) => entry.type === "file" && UPLOAD_TEMP.test(entry.name) && Date.parse(entry.modifiedAt) < cutoff)
      .map((entry) => `${listing.path}/${entry.name}`))
      .filter((path) => path !== keep);
    if (stale.length === 0) return;
    await removeQuietly(user, serverId, stale).catch((error) => console.warn(`mods: server ${serverId}: upload leftovers couldn't be removed: ${(error as Error).message}`));
  }

  /**
   * Whether an error means the host or the server can't be worked on at all right now (offline, timed out, being
   * created or deleted), as opposed to a problem with one file. A 409 alone can be either, so the host and the
   * server's state are asked.
   */
  export async function isHostProblem(opened: Opened, error: unknown): Promise<boolean> {
    if (!(error instanceof HttpError)) return true;
    if (error.status === 503 || error.status === 504) return true;
    if (error.status !== 409) return false;
    if (!AgentGateway.isOnline(opened.server.hostId)) return true;
    const fresh = await GameServer.findByPk(opened.server.id, { attributes: ["state"] });
    return fresh === null || fresh.state === "creating" || fresh.state === "deleting";
  }

  /**
   * Delete paths that should exist; one that is already gone isn't an error.
   */
  export async function removeQuietly(user: User, serverId: string, paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await FileService.remove(user, serverId, [path]);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
  }

  /**
   * Run `task` after every earlier mod operation of the server finished (in memory, per panel process).
   */
  export async function withLock<T>(serverId: string, task: () => Promise<T>): Promise<T> {
    const previous = _locks.get(serverId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => release = resolve);
    const tail = previous.then(() => done);
    _locks.set(serverId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (_locks.get(serverId) === tail) _locks.delete(serverId);
    }
  }
  //#endregion

  //#region Manifest
  /**
   * The manifest, or an empty one when it is missing, not text, not JSON or not a version 1 manifest (logged).
   * Malformed entries are left out.
   */
  export async function readManifest(user: User, serverId: string): Promise<LoadedManifest> {
    let content: string;
    let modifiedAt: string;
    try {
      const res = await FileService.read(user, serverId, MANIFEST_PATH);
      content = res.content;
      modifiedAt = res.entry.modifiedAt;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { manifest: emptyManifest(), modifiedAt: null };
      if (error instanceof HttpError && (error.status === 413 || error.status === 415 || error.status === 400)) {
        console.warn(`mods: server ${serverId}: ${MANIFEST_PATH} can't be read (${error.message}); treating it as empty.`);
        return { manifest: emptyManifest(), modifiedAt: null };
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      console.warn(`mods: server ${serverId}: ${MANIFEST_PATH} isn't valid JSON; treating it as empty.`);
      return { manifest: emptyManifest(), modifiedAt };
    }
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.folders)) {
      console.warn(`mods: server ${serverId}: ${MANIFEST_PATH} isn't a version 1 manifest; treating it as empty.`);
      return { manifest: emptyManifest(), modifiedAt };
    }
    const manifest = emptyManifest();
    let dropped = 0;
    for (const [key, folder] of Object.entries(raw.folders)) {
      if (!isRecord(folder) || !/^[a-z][a-z0-9_]*$/.test(key)) continue;
      const entries = folderEntries(manifest, key);
      for (const [name, entry] of Object.entries(folder)) {
        const clean = ModFolders.isFileName(name) ? cleanEntry(entry) : null;
        if (clean) entries[name] = clean;
        else dropped++;
      }
    }
    if (dropped > 0) console.warn(`mods: server ${serverId}: left out ${dropped} malformed ${MANIFEST_PATH} entries.`);
    return { manifest, modifiedAt };
  }

  /**
   * The folder's entries (created empty when missing), a prototype-free map.
   */
  export function folderEntries(manifest: Manifest, key: string): Record<string, ManifestEntry> {
    return manifest.folders[key] ??= Object.create(null);
  }

  /**
   * Read, change and write the manifest, dropping entries of the scanned folders whose mod is gone (unless a listing
   * was truncated). Nothing is written when nothing changed. A manifest edited in between (409) is read again once.
   */
  export async function changeManifest(user: User, serverId: string, scans: Scan[], mutate: (manifest: Manifest) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const loaded = await readManifest(user, serverId);
      const before = JSON.stringify(loaded.manifest);
      mutate(loaded.manifest);
      for (const folderScan of scans) {
        const entries = loaded.manifest.folders[folderScan.folder.key];
        if (entries === undefined) continue;
        if (!folderScan.enabled.truncated && !folderScan.disabled.truncated) {
          const names = new Set(modsOf(folderScan).map((mod) => mod.entry.name));
          for (const name of Object.keys(entries)) if (!names.has(name)) delete entries[name];
        }
        if (Object.keys(entries).length === 0) delete loaded.manifest.folders[folderScan.folder.key];
      }
      if (JSON.stringify(loaded.manifest) === before) return;
      try {
        await FileService.write(user, serverId, MANIFEST_PATH, `${JSON.stringify(loaded.manifest, null, 2)}\n`, loaded.modifiedAt);
        return;
      } catch (error) {
        if (attempt === 0 && error instanceof HttpError && error.status === 409 && loaded.modifiedAt !== null) continue;
        throw error;
      }
    }
  }

  /**
   * Put entries into a folder of the manifest; an entry with a catalog project replaces that project's other names.
   */
  export function record(manifest: Manifest, key: string, items: { name: string; entry: ManifestEntry }[]): void {
    const folder = folderEntries(manifest, key);
    for (const { name, entry } of items) {
      if (entry.provider !== null && entry.projectId !== null) {
        for (const [other, existing] of Object.entries(folder)) {
          if (other !== name && existing.provider === entry.provider && existing.projectId === entry.projectId) delete folder[other];
        }
      }
      folder[name] = entry;
    }
  }

  /**
   * A manifest entry for a catalog version.
   * @param requiredBy Titles of the mods that need it; empty for a direct install.
   */
  export function catalogEntry(provider: ModCatalogProvider, project: ModCatalog.Project | null, version: ModCatalog.Version, title: string, requiredBy: string[]): ManifestEntry {
    return {
      provider,
      projectId: version.projectId,
      versionId: version.versionId,
      title,
      versionNumber: version.versionNumber,
      iconUrl: project?.iconUrl ?? null,
      pageUrl: project?.pageUrl ?? null,
      installedAt: new Date().toISOString(),
      sha1: version.file.sha1.toLowerCase(),
      requiredBy,
    };
  }

  /**
   * A manifest entry for a file no catalog recognised.
   */
  export function unknownEntry(name: string, sha1: string): ManifestEntry {
    return { provider: null, projectId: null, versionId: null, title: name, versionNumber: null, iconUrl: null, pageUrl: null, installedAt: new Date().toISOString(), sha1, requiredBy: [] };
  }

  /**
   * Ask the folder's usable catalogs that can (`identify`), in order, which versions these SHA-1s are. Best effort: a
   * catalog that fails or takes longer than IDENTIFY_TIMEOUT_MS is skipped. Keyed by SHA-1.
   */
  export async function identify(catalogs: CatalogRef[], sha1s: string[]): Promise<Map<string, Identified>> {
    const found = new Map<string, Identified>();
    for (const { ref, catalog, ctx, unavailable } of catalogs) {
      const missing = sha1s.filter((sha1) => !found.has(sha1));
      if (missing.length === 0 || unavailable !== null || catalog.identify === undefined) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(`no answer within ${IDENTIFY_TIMEOUT_MS / 1000} s`)), IDENTIFY_TIMEOUT_MS));
        const matches = await Promise.race([catalog.identify(ctx, missing), timeout]);
        for (const [sha1, { project, version }] of matches) {
          if (missing.includes(sha1)) found.set(sha1, { entry: { ...catalogEntry(ref.provider, project, version, project.title, []), sha1 }, side: project.side ?? null, label: catalog.label });
        }
      } catch (error) {
        console.warn(`mods: ${catalog.label} couldn't recognise uploaded files: ${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return found;
  }

  function emptyManifest(): Manifest {
    return { version: 1, folders: Object.create(null) };
  }

  function cleanEntry(raw: unknown): ManifestEntry | null {
    if (!isRecord(raw)) return null;
    const text = (value: unknown, max: number): string | null => typeof value === "string" && value !== "" && value.length <= max ? value : null;
    const provider = raw.provider === null ? null : MOD_CATALOG_PROVIDER_VALUES.includes(raw.provider as ModCatalogProvider) ? raw.provider as ModCatalogProvider : undefined;
    if (provider === undefined) return null;
    const title = text(raw.title, MAX_TEXT);
    const sha1 = typeof raw.sha1 === "string" ? raw.sha1.toLowerCase() : "";
    const installedAt = text(raw.installedAt, 64);
    if (title === null || !SHA1.test(sha1) || installedAt === null || Number.isNaN(Date.parse(installedAt))) return null;
    const projectId = text(raw.projectId, MAX_ID);
    const versionId = text(raw.versionId, MAX_ID);
    if (provider !== null && (projectId === null || versionId === null)) return null; // A catalog install names both.
    return {
      provider,
      projectId: provider === null ? null : projectId,
      versionId: provider === null ? null : versionId,
      title,
      versionNumber: text(raw.versionNumber, MAX_TEXT),
      iconUrl: link(raw.iconUrl),
      pageUrl: link(raw.pageUrl),
      installedAt,
      sha1,
      requiredBy: Array.isArray(raw.requiredBy) ? raw.requiredBy.map((value) => text(value, MAX_TEXT)).filter((value) => value !== null).slice(0, MAX_REQUIRED_BY) : [],
    };
  }

  /**
   * An https link to a catalog host (MOD_CATALOG_HOSTS or LINK_HOSTS), else null: the manifest can be edited in the
   * Files tab, and its links end up in the browser.
   */
  function link(value: unknown): string | null {
    if (typeof value !== "string" || value.length > MAX_URL) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
    const hosts = [...Config.MOD_CATALOG_HOSTS.split(",").map((host) => host.trim().toLowerCase()), ...LINK_HOSTS];
    return hosts.includes(url.hostname.toLowerCase()) ? url.href : null;
  }
  //#endregion

  export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export default ModStore;
