/**
 * The Mods tab (`/api/servers/:id/mods`, shared/api/mods.ts): the definition's `mods` folders that apply to a server,
 * listed, uploaded into, enabled/disabled, deleted and installed into from their catalogs. Everything on the host goes
 * through the file API and the transfer relay (`FileService`), so access is `manage` and the host must be online;
 * catalogs are asked by the panel (`ModCatalog`), never by the host. Nothing reaches the agent's spec. The shared
 * parts (folders, manifest, lock, catalog contexts) are in `ModStore`; pack import is `ModPackService`.
 *
 *   list     both folders (`files.list`, a missing folder is empty) → entries matching `match` → joined with the
 *            manifest by folder key and name → updates per catalog by version id (cached UPDATES_CACHE_MS).
 *   state    a move between `folder` and `disabledFolder` per name (`files.rename`, never overwriting).
 *   upload   streamed (outside the lock) to a temporary name, hashed on the way, recognised by SHA-1 (best effort);
 *            then, under the lock, conflicts checked, renamed into place and recorded in the manifest.
 *   install  plan first (the version, then required dependencies recursively, every 409 before anything is
 *            downloaded), then each file downloaded through `ModDownload` (hash-checked before the relay commits),
 *            the project's previous file removed, the manifest written.
 *
 * Mutations of one server's mods take turns (`ModStore.withLock`). It is not `GameServerService`'s lock, which is
 * held for whole installs and starts; game files can change while the game runs, and changes apply at its next start.
 */
import type {
  DeleteModsBody,
  InstallModBody,
  ModCatalogDto,
  ModDependencyDto,
  ModDto,
  ModFolderDto,
  ModInfoDto,
  ModInstallResponse,
  ModSearchResponse,
  ModsResponse,
  ModUpdateDto,
  ModVersionDto,
  SetModStateBody,
  UpdateModsBody,
} from "@shared/api/mods.ts";
import { FILES_DELETE_MAX_PATHS, FILES_LIST_MAX_ENTRIES, type ModCatalogProvider, type ModFolder } from "@shared/protocol/protocol.gen.ts";
import { ModFolders } from "../definitions/ModFolders.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { User } from "../models/index.ts";
import type { ModCatalog } from "../mods/ModCatalog.ts";
import { FileService } from "./FileService.ts";
import { ModDownload } from "./ModDownload.ts";
import { ModStore } from "./ModStore.ts";

export namespace ModService {
  /**
   * Most mods one install or update may download, dependencies included.
   */
  export const MAX_INSTALLS = 30;
  /**
   * Most dependencies read from one version while planning.
   */
  export const MAX_DEPENDENCIES_PER_VERSION = 50;
  /**
   * Most catalog requests one plan may make (versions, pinned versions, titles).
   */
  export const MAX_PLAN_LOOKUPS = 100;
  /**
   * How long the catalog's answer about updates is reused for the same server, folder, catalog and installed versions.
   */
  export const UPDATES_CACHE_MS = 10 * 60 * 1000;
  const UPDATES_FAILURE_CACHE_MS = 60 * 1000; // A catalog that is down isn't asked again on every list.
  const UPDATES_CACHE_MAX_ENTRIES = 500;
  const SEARCH_DEFAULT_LIMIT = 20;
  const SEARCH_MAX_LIMIT = 50;
  const SEARCH_MAX_OFFSET = 10000;
  const QUERY_MAX_CHARS = 200;
  const VERSIONS_LIMIT = 50;
  const PROJECT_ID = /^[A-Za-z0-9_.-]{1,100}$/;

  type ManifestEntry = ModStore.ManifestEntry;
  type CatalogOpened = ModStore.CatalogOpened;

  interface Planned {
    version: ModCatalog.Version;
    dependency: boolean;
    requiredBy: Set<string>; // Project ids of planned mods that need this one.
    keepRequiredBy: string[] | null; // An update keeps the titles it had.
  }

  interface Root {
    projectId: string;
    versionId: string | null;
    version: ModCatalog.Version | null; // Already resolved (updates).
    keepRequiredBy: string[] | null;
  }

  type InstallResult = Omit<ModInstallResponse, "mods">;

  const _updates = new Map<string, { expires: number; updates: Map<string, ModCatalog.Version>; error: string | null }>();

  //#region Routes
  /**
   * The tab's state: every applicable folder with its mods, manifest info and available updates.
   * @throws HttpError 404 without access or when no folder applies, 409 when the host is offline.
   */
  export async function get(user: User, serverId: string): Promise<ModsResponse> {
    return await response(user, await ModStore.open(user, serverId));
  }

  /**
   * Stream an uploaded file into the folder (enabled). The body goes to a temporary name first, outside the lock, and
   * is hashed on the way; then the folder's catalogs are asked what it is (best effort), and under the lock it is
   * renamed into place. With `overwrite`, an entry of the same name in either folder is replaced.
   * @param size The request's Content-Length.
   * @throws HttpError 400 for a name that isn't a plain file name matching a file pattern, 409 "already exists" when
   * the name is taken and `overwrite` is off, 413 over UPLOAD_MAX_MB.
   */
  export async function upload(
    user: User,
    serverId: string,
    key: string,
    name: unknown,
    overwrite: boolean,
    size: number,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ModDto> {
    const opened = await ModStore.open(user, serverId);
    const folder = ModStore.folderOf(opened, key);
    if (!ModFolders.isFileName(name)) throw HttpError.badRequest("\"name\" must be a plain file name (no folders, at most 255 bytes).");
    const patterns = ModFolders.filePatterns(folder);
    if (patterns.length === 0) throw HttpError.badRequest(`${ModStore.labelOf(folder)} only holds folders (${folder.match.join(", ")}). Upload their files in the Files tab instead.`);
    if (!ModFolders.matches(patterns, name, false)) throw HttpError.badRequest(`"${name}" doesn't fit ${ModStore.labelOf(folder)}: the name must match ${patterns.join(" or ")}.`);
    const serverKey = opened.server.id;

    // Fail early, before the body is streamed; checked again under the lock.
    const before = await ModStore.scan(user, serverKey, folder);
    conflicts(folder, before, name, overwrite);
    if (!before.enabled.exists) await ModStore.ensureFolder(user, serverKey, folder.folder);

    const temp = tempPath(folder, name);
    const verified = ModDownload.verify(body, { name, size, sha1: null, sha512: null }, "upload");
    try {
      await FileService.upload(user, serverKey, temp, false, size, verified.stream, signal);
    } catch (error) {
      verified.stream.cancel().catch(() => { });
      throw verified.failure() ?? error;
    }

    try {
      const digests = verified.digests()!;
      const gameVersion = await ModStore.version(user, opened);
      const known = (await ModStore.identify(await ModStore.catalogsOf(opened, folder, gameVersion), [digests.sha1])).get(digests.sha1)?.entry;
      const entry: ManifestEntry = known ?? ModStore.unknownEntry(name, digests.sha1);
      return await ModStore.withLock(serverKey, async () => {
        const now = await ModStore.scan(user, serverKey, folder);
        await ModStore.sweepUploads(user, serverKey, now, temp);
        conflicts(folder, now, name, overwrite);
        const target = `${folder.folder}/${name}`;
        const placed = await FileService.rename(user, serverKey, temp, target, overwrite);
        const twin = now.disabled.entries.find((candidate) => candidate.name === name);
        if (twin) await ModStore.removeQuietly(user, serverKey, [`${ModFolders.disabledFolder(folder)}/${name}`]);
        await ModStore.changeManifest(user, serverKey, [await ModStore.scan(user, serverKey, folder)], (manifest) => {
          ModStore.record(manifest, folder.key, [{ name, entry }]);
        });
        return toModDto({ entry: placed, enabled: true }, entry, null);
      });
    } finally {
      await ModStore.removeQuietly(user, serverKey, [temp]).catch((error) => console.warn(`mods: server ${serverKey}: the temporary upload ${temp} couldn't be removed: ${(error as Error).message}`));
    }
  }

  /**
   * Enable or disable mods by moving them between `folder` and `disabledFolder`. Every name is checked before the
   * first move. A name present in both folders moves its copy from the source folder only when the target has none.
   * @throws HttpError 400 for a name that isn't a listed mod, 409 when the name is taken in the target folder.
   */
  export async function setState(user: User, serverId: string, key: string, body: Partial<SetModStateBody>): Promise<void> {
    const names = checkNames(body.names);
    if (typeof body.enabled !== "boolean") throw HttpError.badRequest("\"enabled\" must be true (enable) or false (disable).");
    const enable = body.enabled;
    const opened = await ModStore.open(user, serverId);
    const folder = ModStore.folderOf(opened, key);
    await ModStore.withLock(opened.server.id, async () => {
      const before = await ModStore.scan(user, opened.server.id, folder);
      await ModStore.sweepUploads(user, opened.server.id, before);
      const mods = ModStore.modsOf(before);
      const source = enable ? before.disabled : before.enabled;
      const target = enable ? before.enabled : before.disabled;
      const moves: string[] = [];
      for (const name of names) {
        const listed = mods.filter((mod) => mod.entry.name === name);
        if (listed.length === 0) throw notListed(folder, name);
        const inSource = listed.some((mod) => mod.enabled !== enable);
        const inTarget = target.entries.some((entry) => entry.name === name);
        if (!inSource) continue; // Already in the target state.
        if (inTarget) {
          throw HttpError.conflict(`"${name}" is in both ${source.path} and ${target.path}. Delete one of the two copies (or rename it in the Files tab) first.`);
        }
        moves.push(name);
      }
      if (moves.length === 0) return;
      if (!target.exists) await ModStore.ensureFolder(user, opened.server.id, target.path);
      for (const name of moves) await FileService.rename(user, opened.server.id, `${source.path}/${name}`, `${target.path}/${name}`, false);
      await ModStore.changeManifest(user, opened.server.id, [await ModStore.scan(user, opened.server.id, folder)], () => { });
    });
  }

  /**
   * Delete mods (files, or folders with their contents) from either folder, and their manifest entries. A name in
   * both folders loses both copies.
   * @returns How many entries were deleted (for the audit: more than the names when copies were in both folders).
   * @throws HttpError 400 for a name that isn't a listed mod.
   */
  export async function remove(user: User, serverId: string, key: string, body: Partial<DeleteModsBody>): Promise<{ deleted: number }> {
    const names = checkNames(body.names);
    const opened = await ModStore.open(user, serverId);
    const folder = ModStore.folderOf(opened, key);
    return await ModStore.withLock(opened.server.id, async () => {
      const before = await ModStore.scan(user, opened.server.id, folder);
      await ModStore.sweepUploads(user, opened.server.id, before);
      const mods = ModStore.modsOf(before);
      const paths: string[] = [];
      for (const name of names) {
        const listed = mods.filter((mod) => mod.entry.name === name);
        if (listed.length === 0) throw notListed(folder, name);
        for (const mod of listed) paths.push(`${mod.enabled ? before.enabled.path : before.disabled.path}/${name}`);
      }
      for (let i = 0; i < paths.length; i += FILES_DELETE_MAX_PATHS) await FileService.remove(user, opened.server.id, paths.slice(i, i + FILES_DELETE_MAX_PATHS));
      await ModStore.changeManifest(user, opened.server.id, [await ModStore.scan(user, opened.server.id, folder)], (manifest) => {
        for (const name of names) delete manifest.folders[folder.key]?.[name];
      });
      return { deleted: paths.length };
    });
  }

  /**
   * Catalog projects for the folder's project type, loaders and the server's game version.
   * @param params The raw query values (`query`, `offset`, `limit`).
   * @throws HttpError 400 for bad paging, 404 without that catalog, 409 when it is unavailable or the version is
   * unknown, 429, 502 from the catalog.
   */
  export async function search(user: User, serverId: string, key: string, provider: string, params: { query?: string; offset?: string; limit?: string }): Promise<ModSearchResponse> {
    const query = (params.query ?? "").trim();
    if (query.length > QUERY_MAX_CHARS) throw HttpError.badRequest(`The search can be at most ${QUERY_MAX_CHARS} characters long.`);
    const offset = intParam(params.offset, "offset", 0, 0, SEARCH_MAX_OFFSET);
    const limit = intParam(params.limit, "limit", SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const c = await ModStore.openCatalog(user, serverId, key, provider);
    ModStore.catalogLimiter.hit(String(user.id));
    const [result, loaded] = await Promise.all([c.catalog.search(c.ctx, query, offset, limit), ModStore.readManifest(user, c.server.id)]);
    const installed = new Set(Object.values(loaded.manifest.folders[c.folder.key] ?? {}).filter((entry) => entry.provider === c.ref.provider).map((entry) => entry.projectId));
    return {
      hits: result.hits.map((project) => ({
        projectId: project.projectId,
        slug: project.slug,
        title: project.title,
        description: project.description,
        author: project.author,
        iconUrl: project.iconUrl,
        pageUrl: project.pageUrl,
        downloads: project.downloads,
        installed: installed.has(project.projectId),
        downloadable: project.downloadable,
      })),
      total: result.total,
      offset,
    };
  }

  /**
   * The project's versions compatible with the server, newest first, with the titles of required and incompatible
   * dependencies when the catalog could name them.
   * @throws HttpError 400 for a malformed project id, 404, 409, 429, 502 like `search`.
   */
  export async function versions(user: User, serverId: string, key: string, provider: string, projectId: string): Promise<ModVersionDto[]> {
    checkId(projectId, "projectId");
    const c = await ModStore.openCatalog(user, serverId, key, provider);
    ModStore.catalogLimiter.hit(String(user.id));
    const list = await c.catalog.versions(c.ctx, projectId, VERSIONS_LIMIT);
    const titled = new Set(list.flatMap((version) => version.dependencies.filter((dep) => dep.type === "required" || dep.type === "incompatible").map((dep) => dep.projectId)).filter((id): id is string => id !== null));
    const titles = new Map<string, string>();
    if (titled.size > 0) {
      try {
        for (const project of await c.catalog.projects(c.ctx, [...titled].slice(0, MAX_PLAN_LOOKUPS))) titles.set(project.projectId, project.title);
      } catch (error) {
        console.warn(`mods: dependency titles of ${projectId} couldn't be fetched: ${(error as Error).message}`);
      }
    }
    return list.map((version) => ({
      versionId: version.versionId,
      name: version.name,
      versionNumber: version.versionNumber,
      publishedAt: version.publishedAt,
      fileName: version.file.name,
      size: version.file.size,
      dependencies: version.dependencies.map((dep): ModDependencyDto => ({
        projectId: dep.projectId,
        versionId: dep.versionId,
        title: dep.projectId !== null && (dep.type === "required" || dep.type === "incompatible") ? titles.get(dep.projectId) ?? null : null,
        type: dep.type,
      })),
    }));
  }

  /**
   * Install a project's version (default the newest compatible one) from one of the folder's catalogs and, unless
   * `dependencies` is false, its required dependencies that aren't installed yet.
   * @throws HttpError 400, 404, 409 when the catalog is unavailable, the version is unknown or a compatible version is
   * missing, 502 when the catalog or a download fails (mods installed before the failure stay, and are recorded).
   */
  export async function install(user: User, serverId: string, key: string, body: Partial<InstallModBody>): Promise<ModInstallResponse> {
    checkId(body.projectId, "projectId");
    if (body.versionId !== undefined && body.versionId !== null) checkId(body.versionId, "versionId");
    if (body.dependencies !== undefined && typeof body.dependencies !== "boolean") throw HttpError.badRequest("\"dependencies\" must be true or false.");
    const c = await ModStore.openCatalog(user, serverId, key, body.provider);
    ModStore.installLimiter.hit(String(user.id));
    return await ModStore.withLock(c.server.id, async () => {
      const result = await installRoots(user, c, [{ projectId: body.projectId as string, versionId: body.versionId ?? null, version: null, keepRequiredBy: null }], body.dependencies ?? true, []);
      return { ...result, mods: await response(user, c) };
    });
  }

  /**
   * Install the newest compatible version of each named mod from the catalog it came from (dependencies included).
   * Names without an update, from an unavailable catalog, or not from a catalog at all are skipped.
   * @throws HttpError 400 for a name that isn't a listed mod, otherwise like `install`.
   */
  export async function update(user: User, serverId: string, key: string, body: Partial<UpdateModsBody>): Promise<ModInstallResponse> {
    const names = checkNames(body.names);
    const opened = await ModStore.open(user, serverId);
    const folder = ModStore.folderOf(opened, key);
    const gameVersion = await ModStore.version(user, opened);
    if (gameVersion === null) throw HttpError.conflict(ModStore.UNKNOWN_VERSION);
    ModStore.installLimiter.hit(String(user.id));
    return await ModStore.withLock(opened.server.id, async () => {
      const mods = ModStore.modsOf(await ModStore.scan(user, opened.server.id, folder));
      const entries = (await ModStore.readManifest(user, opened.server.id)).manifest.folders[folder.key] ?? {};
      const catalogs = await ModStore.catalogsOf(opened, folder, gameVersion);
      const result: InstallResult = { installed: [], skipped: [] };
      const byProvider = new Map<ModCatalogProvider, ManifestEntry[]>();
      for (const name of names) {
        if (!mods.some((mod) => mod.entry.name === name)) throw notListed(folder, name);
        const entry = entries[name];
        const catalog = entry?.provider ? catalogs.find((candidate) => candidate.ref.provider === entry.provider) : undefined;
        if (entry === undefined || entry.provider === null || entry.projectId === null || entry.versionId === null) {
          result.skipped.push({ title: entry?.title ?? name, reason: "Not from a catalog, so its updates aren't known." });
        }
        else if (catalog === undefined || catalog.unavailable !== null) {
          result.skipped.push({ title: entry.title, reason: catalog?.unavailable ?? `${ModStore.labelOf(folder)} no longer installs from ${entry.provider}.` });
        }
        else if (!(byProvider.get(entry.provider) ?? []).some((other) => other.projectId === entry.projectId)) {
          byProvider.set(entry.provider, [...(byProvider.get(entry.provider) ?? []), entry]);
        }
      }
      for (const [provider, list] of byProvider) {
        const ref = catalogs.find((candidate) => candidate.ref.provider === provider)!;
        const c: CatalogOpened = { ...opened, folder, ref: ref.ref, catalog: ref.catalog, ctx: ref.ctx };
        const updates = await ref.catalog.updates(ref.ctx, list.map((entry) => ({ projectId: entry.projectId!, versionId: entry.versionId!, sha1: entry.sha1 })));
        const roots: Root[] = [];
        for (const entry of list) {
          const version = updates.get(entry.versionId!);
          if (version === undefined) result.skipped.push({ title: entry.title, reason: "No newer compatible version." });
          else roots.push({ projectId: version.projectId, versionId: version.versionId, version, keepRequiredBy: entry.requiredBy });
        }
        if (roots.length === 0) continue;
        const installed = await installRoots(user, c, roots, true, result.skipped);
        result.installed.push(...installed.installed);
      }
      return { ...result, mods: await response(user, opened) };
    });
  }
  //#endregion

  //#region Install
  /**
   * Plan, then download and commit each mod (dependencies first), then write the manifest, also after a failure
   * (for the mods that did land). Runs inside the server's lock.
   */
  async function installRoots(user: User, c: CatalogOpened, roots: Root[], withDependencies: boolean, skipped: InstallResult["skipped"]): Promise<InstallResult> {
    const serverId = c.server.id;
    const provider = c.ref.provider;
    const before = await ModStore.scan(user, serverId, c.folder);
    await ModStore.sweepUploads(user, serverId, before);
    const entries = (await ModStore.readManifest(user, serverId)).manifest.folders[c.folder.key] ?? {};
    const present = new Map(ModStore.modsOf(before).map((mod) => [mod.entry.name, mod]));
    // Any manifest entry with the project counts, recognised uploads included.
    const installedProjects = new Set(Object.entries(entries).filter(([name, entry]) => present.has(name) && entry.provider === provider && entry.projectId !== null).map(([, entry]) => entry.projectId!));
    const budget = { lookups: 0 };
    const titles = new Titles(c, budget);
    const planned = await plan(c, roots, withDependencies, installedProjects, titles, skipped, budget);
    await titles.load([...planned.keys()]);

    const installed: InstallResult["installed"] = [];
    const recorded: { name: string; entry: ManifestEntry }[] = [];
    const disabledDir = ModFolders.disabledFolder(c.folder);
    const made = new Set<string>();
    let failure: unknown = null;
    try {
      for (const [projectId, item] of [...planned.entries()].reverse()) {
        const file = item.version.file;
        // The project's earlier files (other versions); a mod that was disabled stays disabled.
        const previous = Object.entries(entries).filter(([name, entry]) => entry.provider === provider && entry.projectId === projectId && present.has(name)).map(([name]) => present.get(name)!);
        const enabled = previous.length === 0 || previous.some((mod) => mod.enabled);
        const dir = enabled ? c.folder.folder : disabledDir;
        if (!made.has(dir) && !(enabled ? before.enabled : before.disabled).exists) {
          await ModStore.ensureFolder(user, serverId, dir);
          made.add(dir);
        }
        const download = await ModDownload.open(file);
        try {
          await FileService.upload(user, serverId, `${dir}/${file.name}`, true, download.size, download.stream);
        } catch (error) {
          download.stream.cancel().catch(() => { });
          throw download.failure() ?? error;
        }
        // Remove what the new file replaces: older files of the project, and the same name in the other folder.
        const stale = previous.filter((mod) => mod.entry.name !== file.name || mod.enabled !== enabled).map((mod) => `${mod.enabled ? c.folder.folder : disabledDir}/${mod.entry.name}`);
        const twin = present.get(file.name);
        if (twin && twin.enabled !== enabled) stale.push(`${twin.enabled ? c.folder.folder : disabledDir}/${file.name}`);
        if (stale.length > 0) await ModStore.removeQuietly(user, serverId, [...new Set(stale)]);

        const title = titles.title(projectId);
        // A direct install has no requiredBy, even when another planned mod needs it too (a dependency cycle).
        const requiredBy = item.keepRequiredBy ?? (item.dependency ? [...item.requiredBy].filter((id) => id !== projectId).map((id) => titles.title(id)) : []);
        recorded.push({ name: file.name, entry: ModStore.catalogEntry(provider, titles.project(projectId), item.version, title, requiredBy) });
        installed.push({ name: file.name, title, versionNumber: item.version.versionNumber, dependency: item.dependency });
      }
    } catch (error) {
      failure = error;
    }

    if (recorded.length > 0) {
      try {
        await ModStore.changeManifest(user, serverId, [await ModStore.scan(user, serverId, c.folder)], (manifest) => ModStore.record(manifest, c.folder.key, recorded));
      } catch (error) {
        if (failure === null) throw error;
        console.error(`mods: server ${serverId}: the manifest couldn't be written after a failed install`, error);
      }
    }
    if (failure !== null) throw failure;
    return { installed, skipped };
  }

  /**
   * The mods to install by project id, roots first, then dependencies breadth-first. Every 409 (no compatible
   * version, too many mods, dependencies or lookups) happens here, before anything is downloaded.
   */
  async function plan(
    c: CatalogOpened,
    roots: Root[],
    withDependencies: boolean,
    installedProjects: Set<string>,
    titles: Titles,
    skipped: InstallResult["skipped"],
    budget: { lookups: number },
  ): Promise<Map<string, Planned>> {
    const planned = new Map<string, Planned>();
    const reported = new Set<string>();
    const add = (projectId: string, item: Planned) => {
      if (planned.size >= MAX_INSTALLS) throw HttpError.conflict(`This would install more than ${MAX_INSTALLS} mods at once. Install the dependencies separately, or without dependencies.`);
      planned.set(projectId, item);
    };
    const lookup = <T>(request: () => Promise<T>): Promise<T> => {
      if (++budget.lookups > MAX_PLAN_LOOKUPS) throw HttpError.conflict(`Working out the dependencies needs more than ${MAX_PLAN_LOOKUPS} catalog requests. Install without dependencies, or install them one by one.`);
      return request();
    };
    const newest = async (projectId: string) => (await lookup(() => c.catalog.versions(c.ctx, projectId, 1)))[0] ?? null;

    for (const root of roots) {
      let version = root.version;
      if (version === null && root.versionId !== null) {
        const picked = await lookup(() => c.catalog.version(c.ctx, root.versionId!));
        if (picked.version.projectId !== root.projectId) throw HttpError.badRequest(`The version "${root.versionId}" doesn't belong to the project "${root.projectId}".`);
        if (!picked.compatible) throw HttpError.conflict(`${picked.version.versionNumber} of "${await titles.fetch(root.projectId)}" doesn't run on ${describe(c.ctx)}. Pick another version.`);
        version = picked.version;
      }
      version ??= await newest(root.projectId);
      if (version === null) {
        const project = await titles.fetchProject(root.projectId);
        if (project?.downloadable === false) {
          throw HttpError.conflict(`The author of "${project.title}" doesn't allow downloads outside ${c.catalog.label}'s own app. Download it from ${project.pageUrl} and drop it in.`);
        }
        throw HttpError.conflict(`"${project?.title ?? root.projectId}" has no version for ${describe(c.ctx)}.`);
      }
      if (!ModStore.fitsFolder(c.folder, version.file.name)) {
        throw HttpError.conflict(`The file of "${await titles.fetch(root.projectId)}" (${version.file.name}) doesn't fit ${ModStore.labelOf(c.folder)}, which takes ${ModFolders.filePatterns(c.folder).join(", ") || "folders only"}.`);
      }
      if (!planned.has(root.projectId)) add(root.projectId, { version, dependency: false, requiredBy: new Set(), keepRequiredBy: root.keepRequiredBy });
    }
    if (!withDependencies) return planned;

    for (const [parentId, parent] of planned) { // A Map iterates the entries added while iterating.
      if (parent.version.dependencies.length > MAX_DEPENDENCIES_PER_VERSION) {
        throw HttpError.conflict(`"${await titles.fetch(parentId)}" lists more than ${MAX_DEPENDENCIES_PER_VERSION} dependencies. Install it without dependencies.`);
      }
      for (const dep of parent.version.dependencies) {
        if (dep.type === "optional" || dep.type === "embedded") continue;
        if (dep.type === "incompatible") {
          if (dep.projectId === null || reported.has(`!${dep.projectId}`)) continue;
          if (installedProjects.has(dep.projectId) || planned.has(dep.projectId)) {
            reported.add(`!${dep.projectId}`);
            skipped.push({ title: await titles.fetch(dep.projectId), reason: `Incompatible with "${await titles.fetch(parentId)}"; remove one of them.` });
          }
          continue;
        }
        // Known project: settle planned/installed before any lookup. Only a bare version id needs one first.
        let projectId = dep.projectId;
        let pinned: { version: ModCatalog.Version; compatible: boolean } | null = null;
        const pin = async () => await lookup(() => c.catalog.version(c.ctx, dep.versionId!)).catch((error) => {
          if (error instanceof HttpError && error.status === 404) return null; // A pin to a deleted version: use the newest.
          throw error;
        });
        if (projectId === null) {
          if (dep.versionId === null) continue;
          pinned = await pin();
          projectId = pinned?.version.projectId ?? null;
          if (projectId === null) continue;
        }
        const existing = planned.get(projectId);
        if (existing) {
          existing.requiredBy.add(parentId);
          continue;
        }
        if (installedProjects.has(projectId)) {
          if (!reported.has(projectId)) {
            reported.add(projectId);
            skipped.push({ title: await titles.fetch(projectId), reason: "Already installed." });
          }
          continue;
        }
        if (pinned === null && dep.versionId !== null) pinned = await pin();
        let version = pinned?.compatible && pinned.version.projectId === projectId ? pinned.version : null;
        version ??= await newest(projectId);
        if (version === null) {
          throw HttpError.conflict(`"${await titles.fetch(parentId)}" needs "${await titles.fetch(projectId)}", which has no version for ${describe(c.ctx)} the panel can download. Install without dependencies to skip it, or pick another version.`);
        }
        if (!ModStore.fitsFolder(c.folder, version.file.name)) {
          reported.add(projectId);
          skipped.push({ title: await titles.fetch(projectId), reason: `Its file (${version.file.name}) doesn't fit ${ModStore.labelOf(c.folder)}.` });
          continue;
        }
        add(projectId, { version, dependency: true, requiredBy: new Set([parentId]), keepRequiredBy: null });
      }
    }
    return planned;
  }

  /**
   * Project titles (and icons, pages) by id, asked of the catalog at most once each and counted against the plan's
   * lookups; a failed lookup falls back to the id.
   */
  class Titles {
    private readonly _projects = new Map<string, ModCatalog.Project | null>();

    constructor(private readonly _c: CatalogOpened, private readonly _budget: { lookups: number }) { }

    /**
     * Load the projects not known yet in one request.
     */
    public async load(projectIds: string[]): Promise<void> {
      const missing = projectIds.filter((id) => !this._projects.has(id));
      if (missing.length === 0) return;
      try {
        for (const project of await this._c.catalog.projects(this._c.ctx, missing)) this._projects.set(project.projectId, project);
      } catch (error) {
        console.warn(`mods: project titles couldn't be fetched: ${(error as Error).message}`);
      }
      for (const id of missing) if (!this._projects.has(id)) this._projects.set(id, null);
    }

    /**
     * The project, fetching it when it isn't known yet (null when the catalog can't say, or the budget is spent).
     */
    public async fetchProject(projectId: string): Promise<ModCatalog.Project | null> {
      if (!this._projects.has(projectId)) {
        const affordable = ++this._budget.lookups <= MAX_PLAN_LOOKUPS;
        this._projects.set(projectId, affordable ? await this._c.catalog.project(this._c.ctx, projectId).catch(() => null) : null);
      }
      return this._projects.get(projectId) ?? null;
    }

    public async fetch(projectId: string): Promise<string> {
      return (await this.fetchProject(projectId))?.title ?? projectId;
    }

    public title(projectId: string): string {
      return this._projects.get(projectId)?.title ?? projectId;
    }

    public project(projectId: string): ModCatalog.Project | null {
      return this._projects.get(projectId) ?? null;
    }
  }
  //#endregion

  //#region State
  async function response(user: User, opened: ModStore.Opened): Promise<ModsResponse> {
    const gameVersion = await ModStore.version(user, opened);
    const [scans, loaded] = await Promise.all([
      Promise.all(opened.folders.map(async (folder) => {
        try {
          return await ModStore.scan(user, opened.server.id, folder);
        } catch (error) {
          // One folder the agent can't list (a file named like it, a permission problem) shouldn't hide the others.
          if (!(error instanceof HttpError) || error.status === 409 || error.status >= 500) throw error;
          console.warn(`mods: server ${opened.server.id}: ${folder.folder} can't be listed: ${error.message}`);
          const empty = (path: string): ModStore.Listing => ({ path, exists: false, truncated: true, entries: [] });
          return { folder, enabled: empty(folder.folder), disabled: empty(ModFolders.disabledFolder(folder)) };
        }
      })),
      ModStore.readManifest(user, opened.server.id),
    ]);
    const folders = await Promise.all(scans.map(async (folderScan): Promise<ModFolderDto> => {
      const folder = folderScan.folder;
      const entries = loaded.manifest.folders[folder.key] ?? {};
      const mods = ModStore.modsOf(folderScan);
      const catalogs = await ModStore.catalogsOf(opened, folder, gameVersion);
      const present = mods.map((mod) => entries[mod.entry.name]).filter((entry) => entry !== undefined);
      const { updates, error } = await updatesFor(opened, folder, gameVersion, catalogs, present);
      return {
        key: folder.key,
        label: ModStore.labelOf(folder),
        description: folder.description ?? null,
        folder: folder.folder,
        disabledFolder: ModFolders.disabledFolder(folder),
        match: folder.match,
        catalogs: catalogs.map((catalog): ModCatalogDto => ({
          provider: catalog.ref.provider,
          label: catalog.catalog.label,
          projectType: catalog.ref.project_type,
          loaders: catalog.ctx.loaders,
          available: catalog.unavailable === null,
          unavailableReason: catalog.unavailable,
        })),
        packs: folder.packs?.formats ?? [],
        mods: mods.slice(0, FILES_LIST_MAX_ENTRIES).map((mod) => {
          const entry = entries[mod.entry.name] ?? null;
          const available = entry?.provider && entry.versionId ? updates.get(`${entry.provider}:${entry.versionId}`) : undefined;
          return toModDto(mod, entry, available === undefined ? null : { versionId: available.versionId, versionNumber: available.versionNumber, publishedAt: available.publishedAt });
        }),
        updatesError: error,
      };
    }));
    return { version: gameVersion, folders };
  }

  /**
   * Available updates of the folder's catalog mods, keyed by `<provider>:<versionId>`, asked per usable catalog and
   * cached per server, folder, catalog context and set of installed versions. Failures name the catalog.
   */
  async function updatesFor(
    opened: ModStore.Opened,
    folder: ModFolder,
    gameVersion: string | null,
    catalogs: ModStore.CatalogRef[],
    entries: ManifestEntry[],
  ): Promise<{ updates: Map<string, ModCatalog.Version>; error: string | null }> {
    const updates = new Map<string, ModCatalog.Version>();
    const errors: string[] = [];
    for (const { ref, catalog, ctx, unavailable } of catalogs) {
      const installed = entries.filter((entry) => entry.provider === ref.provider && entry.projectId !== null && entry.versionId !== null)
        .map((entry): ModCatalog.Installed => ({ projectId: entry.projectId!, versionId: entry.versionId!, sha1: entry.sha1 }))
        .sort((a, b) => a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0);
      if (installed.length === 0 || unavailable !== null) continue;
      if (gameVersion === null) {
        errors.push(`${catalog.label}: the game version isn't known yet, so updates can't be checked. Install or start the server once.`);
        continue;
      }
      const { apiKey: _apiKey, ...shape } = ctx;
      const cacheKey = JSON.stringify([opened.server.id, folder.key, ref.provider, shape, installed.map((item) => item.versionId)]);
      const now = Date.now();
      let result = _updates.get(cacheKey);
      if (!result || result.expires <= now) {
        try {
          result = { updates: await catalog.updates(ctx, installed), error: null, expires: now + UPDATES_CACHE_MS };
        } catch (error) {
          console.warn(`mods: server ${opened.server.id}: ${catalog.label} updates of ${folder.key} couldn't be checked: ${(error as Error).message}`);
          const message = error instanceof HttpError ? error.message : "it couldn't be reached";
          result = { updates: new Map(), error: `${catalog.label}: ${message}`, expires: now + UPDATES_FAILURE_CACHE_MS };
        }
        for (const [key, cached] of _updates) if (cached.expires <= now) _updates.delete(key);
        if (_updates.size >= UPDATES_CACHE_MAX_ENTRIES) _updates.delete(_updates.keys().next().value!);
        _updates.set(cacheKey, result);
      }
      if (result.error !== null) errors.push(result.error);
      for (const [versionId, version] of result.updates) updates.set(`${ref.provider}:${versionId}`, version);
    }
    return { updates, error: errors.length === 0 ? null : errors.join(" ") };
  }
  //#endregion

  //#region Helpers
  /**
   * The upload's name clashes: a folder of that name, or (without overwrite) an entry in either folder.
   */
  function conflicts(folder: ModFolder, folderScan: ModStore.Scan, name: string, overwrite: boolean): void {
    const enabled = folderScan.enabled.entries.find((entry) => entry.name === name);
    const disabled = folderScan.disabled.entries.find((entry) => entry.name === name);
    if (enabled?.type === "dir") throw HttpError.conflict(`"${name}" is a folder in ${folder.folder}, so a file can't replace it. Delete or rename the folder first.`);
    if (!overwrite && enabled) throw HttpError.conflict(`"${name}" already exists in ${folder.folder}. Replace it?`);
    if (!overwrite && disabled) throw HttpError.conflict(`"${name}" already exists in ${ModFolders.disabledFolder(folder)} (disabled). Replace it?`);
  }

  /**
   * Where an upload is streamed before it is renamed into place: a hidden name next to its target that matches none
   * of the folder's patterns (so it is never listed as a mod), else the data root.
   */
  function tempPath(folder: ModFolder, name: string): string {
    const random = crypto.randomUUID().slice(0, 8);
    for (const candidate of [`.${name}.gss-upload-${random}`, `.gss-upload-${random}`]) {
      if (ModFolders.isFileName(candidate) && !ModFolders.matches(folder.match, candidate, false)) return `${folder.folder}/${candidate}`;
    }
    return `.gss-upload-${random}`;
  }

  function toModDto(mod: ModStore.ListedMod, entry: ManifestEntry | null, update: ModUpdateDto | null): ModDto {
    const isFolder = mod.entry.type === "dir";
    const info: ModInfoDto | null = entry === null ? null : {
      provider: entry.provider,
      projectId: entry.projectId,
      versionId: entry.versionId,
      title: entry.title,
      versionNumber: entry.versionNumber,
      iconUrl: entry.iconUrl,
      pageUrl: entry.pageUrl,
      installedAt: entry.installedAt,
      requiredBy: entry.requiredBy,
    };
    return { name: mod.entry.name, enabled: mod.enabled, isFolder, size: isFolder ? null : mod.entry.size, modifiedAt: mod.entry.modifiedAt, info, update };
  }

  function describe(ctx: ModCatalog.Context): string {
    return `game version ${ctx.gameVersion}${ctx.loaders.length > 0 ? ` with ${ctx.loaders.join(", ")}` : ""}`;
  }

  function notListed(folder: ModFolder, name: string): HttpError {
    return HttpError.badRequest(`"${name}" isn't a mod in ${ModStore.labelOf(folder)}. Reload the list and try again.`);
  }

  /**
   * The body's `names`: 1 to FILES_DELETE_MAX_PATHS plain names, duplicates dropped.
   */
  function checkNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) throw HttpError.badRequest("\"names\" must list the mods by their names.");
    if (value.length > FILES_DELETE_MAX_PATHS) throw HttpError.badRequest(`At most ${FILES_DELETE_MAX_PATHS} mods can be changed at once.`);
    value.forEach((name, i) => {
      if (!ModFolders.isFileName(name)) throw HttpError.badRequest(`"names[${i}]" must be a mod's name as listed (no folders).`);
    });
    return [...new Set(value as string[])];
  }

  function checkId(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string" || !PROJECT_ID.test(value)) throw HttpError.badRequest(`"${field}" must be a catalog id (letters, digits, "-", "_" or ".", at most 100).`);
  }

  function intParam(value: string | undefined, field: string, fallback: number, min: number, max: number): number {
    if (value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw HttpError.badRequest(`"${field}" must be a whole number from ${min} to ${max}.`);
    return number;
  }
  //#endregion
}

export default ModService;
