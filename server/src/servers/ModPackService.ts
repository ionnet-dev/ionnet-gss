/**
 * Modpack import for the Mods tab (`/api/servers/:id/mods/:folder/packs`, shared/api/mods.ts `ModPackPreviewDto`): a
 * Modrinth `.mrpack`, a CurseForge profile or export, or a zip of mod files, for folders whose definition has `packs`.
 *
 *   preview  the raw body streamed (no lock) to a temporary file below the panel's data folder (`mod-packs/`) →
 *            `ModPack.parse` → every mod resolved (included in the pack; mrpack downloads on allowed hosts; CurseForge
 *            files through the operator's key) → warnings → the plan kept in memory under a random token (per user,
 *            PLAN_TTL_MS, at most PLANS_PER_USER; the oldest goes first). Nothing on the host changes.
 *   apply    under the server's mod lock: each selected mod downloaded (hash-checked) or extracted (CRC-checked by the
 *            parser, hashed here) into the folder, mrpack files outside `mods/` into their override folder, override
 *            files written below `packs.overrides` (parents created, existing files replaced; mrpack downloads there
 *            are hash-checked like mods; other paths are only listed in the preview), the manifest written
 *            (catalog info, else recognised by SHA-1 where a catalog can, else unknown). One entry that fails is
 *            reported in `skipped` (also an `include`d one the panel can't get); a host that is offline or a server
 *            being created or deleted (`ModStore.isHostProblem`) ends the run. The token and its file go afterwards.
 *
 * At most PLANS_TOTAL previews and `bytesTotal()` bytes of pack files wait at once over all users (503 beyond). A
 * pack made for another loader or game version starts with its mods unselected, as do client-only mods (the pack's
 * `env`, else the catalog's `Project.side`).
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import Path from "node:path";
import type { ApplyModPackBody, ModInstallResponse, ModPackEntryDto, ModPackPreviewDto } from "@shared/api/mods.ts";
import type { ModFolder } from "@shared/protocol/protocol.gen.ts";
import { AppSystem } from "../AppSystem.ts";
import { Config } from "../Config.ts";
import { ModFolders } from "../definitions/ModFolders.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { User } from "../models/index.ts";
import { ModCatalog } from "../mods/ModCatalog.ts";
import { ModPack } from "../mods/ModPack.ts";
import { FileService } from "./FileService.ts";
import { ModDownload } from "./ModDownload.ts";
import { ModService } from "./ModService.ts";
import { ModCatalogKeys } from "./ModCatalogKeys.ts";
import { ModStore } from "./ModStore.ts";

export namespace ModPackService {
  /**
   * How long a preview can be applied.
   */
  export const PLAN_TTL_MS = 30 * 60 * 1000;
  /**
   * Previews one user may hold at once.
   */
  export const PLANS_PER_USER = 3;
  /**
   * Where uploaded packs wait for `apply`.
   */
  export const PACKS_DIR = Path.join(AppSystem.dataDir, "mod-packs");
  /**
   * Previews all users together may hold (their files wait on the panel's disk).
   */
  export const PLANS_TOTAL = 20;
  /**
   * Bytes all waiting pack files together may take: twice MOD_PACK_MAX_MB.
   */
  export function bytesTotal(): number {
    return 2 * Config.MOD_PACK_MAX_MB * 1048576;
  }
  /**
   * Most included files hashed at preview time (to recognise them); the rest are recognised after apply.
   */
  const MAX_HASHED_INCLUDED = 500;
  const SAMPLE_PATHS = 20;

  type ManifestEntry = ModStore.ManifestEntry;

  /**
   * How `apply` gets one entry's bytes, and where they go.
   */
  type Source =
    | { kind: "included"; mod: ModPack.IncludedMod }
    | { kind: "file"; entry: ModPack.FileEntry }
    | { kind: "url"; file: { url: string; name: string; size: number; sha1: string; sha512: string | null } }
    | { kind: "catalog"; version: ModCatalog.Version };

  interface PlanEntry {
    dto: ModPackEntryDto;
    source: Source | null; // null = not downloadable.
    target: string | null; // Path below /data.
    isMod: boolean; // Lands in the folder (recorded in the manifest), else an override path.
    record: ManifestEntry | null; // Catalog info known at preview time; else recognised after the upload.
  }

  /**
   * A file `apply` writes below an override folder: from the archive, or an mrpack download.
   */
  interface OverrideFile {
    path: string;
    size: number;
    source: Source;
  }

  interface Plan {
    token: string;
    userId: number;
    serverId: string;
    folderKey: string;
    file: string;
    name: string;
    entries: PlanEntry[];
    overrides: OverrideFile[];
    expiresAt: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    busy: boolean; // An apply runs: never evicted, expired or applied twice.
    bytes: number; // The pack file's size, counted in `_reservedBytes` until it is removed.
  }

  const _plans = new Map<string, Plan>();
  let _reservedBytes = 0; // Pack files on disk or being received.
  let _receiving = 0;
  let _cleaned: Promise<void> | null = null;

  //#region Routes
  /**
   * Stream a pack to a temporary file, parse it and answer the preview.
   * @param size The request's Content-Length.
   * @throws HttpError 400 (name, format, a broken pack), 404 when the folder imports no packs, 413 over MOD_PACK_MAX_MB.
   */
  export async function preview(user: User, serverId: string, key: string, name: unknown, size: number, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<ModPackPreviewDto> {
    const opened = await ModStore.open(user, serverId);
    const folder = ModStore.folderOf(opened, key);
    if (folder.packs === undefined) throw HttpError.notFound(`${ModStore.labelOf(folder)} doesn't import modpacks.`);
    if (!ModFolders.isFileName(name)) throw HttpError.badRequest("\"name\" must be the pack's file name (no folders, at most 255 bytes).");
    if (size > Config.MOD_PACK_MAX_MB * 1048576) throw HttpError.tooLarge(`Modpacks are limited to ${Config.MOD_PACK_MAX_MB} MB (MOD_PACK_MAX_MB).`);
    if (_plans.size + _receiving >= PLANS_TOTAL || _reservedBytes + size > bytesTotal()) {
      throw new HttpError(503, "The panel is busy importing other packs; try again in a few minutes.");
    }
    ModStore.installLimiter.hit(String(user.id));
    _reservedBytes += size;
    _receiving++;
    let stored = false;
    try {
      return await previewReceived(user, opened, folder, name, size, body, signal, () => stored = true);
    } finally {
      _receiving--;
      if (!stored) _reservedBytes -= size;
    }
  }

  async function previewReceived(
    user: User,
    opened: ModStore.Opened,
    folder: ModFolder,
    name: string,
    size: number,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    onStored: () => void,
  ): Promise<ModPackPreviewDto> {
    const packs = folder.packs!;
    const file = await receive(name, size, body, signal);
    let parsed: ModPack.Parsed;
    try {
      parsed = await ModPack.parse(file, name, packs.formats);
    } catch (error) {
      await fsp.rm(file, { force: true });
      throw error;
    }

    try {
      const gameVersion = await ModStore.version(user, opened);
      const catalogs = await ModStore.catalogsOf(opened, folder, gameVersion);
      const folderScan = await ModStore.scan(user, opened.server.id, folder);
      const manifest = (await ModStore.readManifest(user, opened.server.id)).manifest.folders[folder.key] ?? {};
      const names = new Set(ModStore.modsOf(folderScan).map((mod) => mod.entry.name));
      const projects = new Set(Object.entries(manifest).filter(([entryName, entry]) => names.has(entryName) && entry.provider !== null).map(([, entry]) => `${entry.provider}:${entry.projectId}`));
      const overrideFolders = packs.overrides ?? [];
      const overrides: OverrideFile[] = [];
      const skippedFiles: string[] = [];
      for (const entry of parsed.files) {
        if (isOverride(overrideFolders, entry.path)) overrides.push({ path: entry.path, size: entry.size, source: { kind: "file", entry } });
        else skippedFiles.push(entry.path);
      }
      const mismatch = mismatches(parsed, gameVersion, catalogs);
      const entries = await resolve(folder, parsed, catalogs, names, projects, overrides, skippedFiles, mismatch.length > 0 ? mismatch.join(" ") : null);
      const warnings = [...parsed.warnings, ...mismatch];
      if (mismatch.length > 0) warnings.push("Its mods start unselected because of that; select the ones you know work.");
      const manual = entries.filter((entry) => !entry.dto.downloadable).length;
      if (manual > 0) warnings.push(`${manual} ${manual === 1 ? "mod" : "mods"} can't be downloaded by the panel: download ${manual === 1 ? "it" : "them"} yourself and drop ${manual === 1 ? "it" : "them"} in.`);
      if (parsed.format === "curseforge") warnings.push("CurseForge profiles can contain client-only mods; disable any that stop the server from starting.");
      if (skippedFiles.length > 0) warnings.push(`${skippedFiles.length} other ${skippedFiles.length === 1 ? "file is" : "files are"} outside the folders this game takes from packs (${overrideFolders.join(", ") || "none"}) and will be left out.`);

      const plan = store({
        token: crypto.randomUUID().replaceAll("-", ""),
        userId: user.id,
        serverId: opened.server.id,
        folderKey: folder.key,
        file,
        name: parsed.name,
        entries,
        overrides,
        expiresAt: Date.now() + PLAN_TTL_MS,
        timer: undefined,
        busy: false,
        bytes: size,
      });
      onStored();
      return {
        token: plan.token,
        format: parsed.format,
        name: parsed.name,
        version: parsed.version,
        gameVersion: parsed.gameVersion,
        loaders: parsed.loaders,
        warnings,
        mods: entries.map((entry) => entry.dto),
        overrides: {
          count: overrides.length,
          bytes: overrides.reduce((sum, entry) => sum + entry.size, 0),
          sample: overrides.slice(0, SAMPLE_PATHS).map((entry) => entry.path),
          skipped: skippedFiles.slice(0, SAMPLE_PATHS),
        },
        expiresAt: new Date(plan.expiresAt).toISOString(),
      };
    } catch (error) {
      await fsp.rm(file, { force: true });
      throw error;
    }
  }

  /**
   * Install a previewed pack's selected mods and (unless `overrides` is false) write its override files.
   * @returns The install response, plus counts for the audit.
   * @throws HttpError 400 for a malformed body, 404 when the token is unknown, expired or someone else's.
   */
  export async function apply(user: User, serverId: string, key: string, token: string, body: Partial<ApplyModPackBody>): Promise<{ response: ModInstallResponse; name: string; overrides: number }> {
    const plan = _plans.get(token);
    if (!plan || plan.expiresAt <= Date.now() || plan.userId !== user.id || plan.serverId !== serverId.toLowerCase() || plan.folderKey !== key || plan.busy) {
      throw HttpError.notFound("This pack preview has expired (or was already applied). Upload the pack again.");
    }
    plan.busy = true; // Before any await: a second apply of the same token gets the 404 above.
    let skip: Set<string>, include: Set<string>, opened: ModStore.Opened, folder: ModFolder;
    try {
      skip = keyList(body.skip, "skip");
      include = keyList(body.include, "include");
      if (body.overrides !== undefined && typeof body.overrides !== "boolean") throw HttpError.badRequest("\"overrides\" must be true or false.");
      opened = await ModStore.open(user, serverId);
      folder = ModStore.folderOf(opened, key);
      ModStore.installLimiter.hit(String(user.id));
    } catch (error) {
      plan.busy = false; // Nothing happened: the preview can be applied again.
      throw error;
    }
    try {
      return await ModStore.withLock(opened.server.id, async () => {
        const result = await install(user, opened, folder, plan, skip, include, body.overrides ?? true);
        return { response: { ...result, mods: await ModService.get(user, serverId) }, name: plan.name, overrides: result.overrides };
      });
    } finally {
      await discard(plan);
    }
  }
  //#endregion

  //#region Preview
  /**
   * The body as a temporary file in PACKS_DIR (exactly `size` bytes, no stall over `ModDownload.IDLE_MS`).
   */
  async function receive(name: string, size: number, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
    _cleaned ??= fsp.rm(PACKS_DIR, { recursive: true, force: true }).catch(() => { }); // Leftovers of an earlier run.
    await _cleaned;
    await fsp.mkdir(PACKS_DIR, { recursive: true, mode: 0o700 });
    const file = Path.join(PACKS_DIR, crypto.randomUUID());
    const verified = ModDownload.verify(body, { name, size, sha1: null, sha512: null }, "upload");
    const handle = await Deno.open(file, { write: true, createNew: true, mode: 0o600 });
    try {
      await verified.stream.pipeTo(handle.writable, { signal });
    } catch (error) {
      await fsp.rm(file, { force: true });
      throw verified.failure() ?? (signal?.aborted ? HttpError.badRequest("The upload was cancelled.") : error);
    }
    return file;
  }

  /**
   * Every mod of the pack as a plan entry: where it comes from, where it goes and whether it is selected.
   */
  async function resolve(
    folder: ModFolder,
    parsed: ModPack.Parsed,
    catalogs: ModStore.CatalogRef[],
    names: Set<string>,
    projects: Set<string>,
    overrides: OverrideFile[],
    skippedFiles: string[],
    mismatch: string | null, // "Made for …; this server runs …": catalog and included mods start unselected.
  ): Promise<PlanEntry[]> {
    const overrideFolders = folder.packs?.overrides ?? [];
    const label = ModStore.labelOf(folder);
    const patterns = ModFolders.filePatterns(folder).join(", ") || "folders only";
    const entries: PlanEntry[] = [];
    const keys = new Set<string>();
    const keyOf = (base: string) => {
      let candidate = base;
      for (let i = 2; keys.has(candidate); i++) candidate = `${base}#${i}`;
      keys.add(candidate);
      return candidate;
    };
    const base = (key: string, title: string, source: ModPackEntryDto["source"]): ModPackEntryDto => ({
      key: keyOf(key), title, fileName: null, size: null, source, pageUrl: null, side: null, downloadable: false, reason: null, selected: false, alreadyInstalled: false,
    });

    // mrpack titles: ask the catalogs that can recognise files (best effort).
    const isModPath = (path: string) => /^mods\/[^/]+$/.test(path);
    const modrinthMods = parsed.mods.filter((mod): mod is ModPack.ModrinthMod => mod.kind === "modrinth" && isModPath(mod.path));
    // Included files are hashed here so the catalogs can name them (and say when one is client-only).
    const includedSha1 = new Map<ModPack.IncludedMod, string>();
    for (const mod of parsed.mods) {
      if (mod.kind !== "included" || includedSha1.size >= MAX_HASHED_INCLUDED || !ModStore.fitsFolder(folder, mod.name)) continue;
      const sha1 = await hashOf(mod);
      if (sha1 !== null) includedSha1.set(mod, sha1);
    }
    const sha1s = [...modrinthMods.map((mod) => mod.sha1.toLowerCase()), ...includedSha1.values()];
    const known = sha1s.length > 0 ? await ModStore.identify(catalogs, [...new Set(sha1s)]) : new Map<string, ModStore.Identified>();
    const clientOnly = (identified: ModStore.Identified) => `Client-only mod (${identified.label} says it doesn't run on servers).`;

    // CurseForge files: through the folder's curseforge catalog and the operator's key.
    const cfMods = parsed.mods.filter((mod): mod is ModPack.CurseForgeMod => mod.kind === "curseforge");
    const cf = catalogs.find((catalog) => catalog.ref.provider === "curseforge");
    let cfVersions = new Map<string, ModCatalog.Version>();
    const cfProjects = new Map<string, ModCatalog.Project>();
    let cfProblem: string | null = cf === undefined
      ? `${label} has no CurseForge catalog, so the panel can't download CurseForge files. Download them from CurseForge and drop them into the folder.`
      : cf.ctx.apiKey === null && cf.unavailable !== ModCatalogKeys.UNREADABLE ? "No CurseForge API key is set; download it from CurseForge and drop it into the folder." : cf.unavailable;
    if (cfMods.length > 0 && cf !== undefined && cfProblem === null) {
      try {
        cfVersions = await cf.catalog.versionsById(cf.ctx, [...new Set(cfMods.map((mod) => mod.fileId))]);
        for (const project of await cf.catalog.projects(cf.ctx, [...new Set(cfMods.map((mod) => mod.projectId))])) cfProjects.set(project.projectId, project);
      } catch (error) {
        cfProblem = `CurseForge couldn't be asked: ${(error as Error).message}`;
      }
    }

    for (const mod of parsed.mods) {
      if (mod.kind === "included") {
        const dto = base(`i:${mod.path}`, mod.name, "included");
        dto.fileName = mod.name;
        dto.size = mod.size;
        const sha1 = includedSha1.get(mod) ?? null;
        const identified = sha1 === null ? null : known.get(sha1) ?? null;
        dto.title = identified?.entry.title ?? mod.name;
        dto.pageUrl = identified?.entry.pageUrl ?? null;
        dto.side = identified?.side ?? null;
        dto.alreadyInstalled = names.has(mod.name) || (identified !== null && projects.has(`${identified.entry.provider}:${identified.entry.projectId}`));
        const fits = ModStore.fitsFolder(folder, mod.name);
        dto.downloadable = fits;
        dto.reason = fits ? null : `Its name doesn't fit ${label}, which takes ${patterns}.`;
        if (fits && identified?.side === "client") dto.reason = clientOnly(identified);
        dto.selected = fits && dto.side !== "client";
        const record = identified?.entry ?? (sha1 === null ? null : ModStore.unknownEntry(mod.name, sha1));
        entries.push({ dto, source: fits ? { kind: "included", mod } : null, target: fits ? `${folder.folder}/${mod.name}` : null, isMod: true, record });
      }
      else if (mod.kind === "modrinth") {
        const url = mod.urls.find((candidate) => ModCatalog.fetchAllowed(candidate)) ?? null;
        const file = { url: url ?? "", name: mod.name, size: mod.size, sha1: mod.sha1, sha512: mod.sha512 };
        if (!isModPath(mod.path)) {
          // Every mrpack file comes as a "mod": below an override folder it is written there, anything else is left out.
          if (isOverride(overrideFolders, mod.path) && url !== null && mod.side !== "client") overrides.push({ path: mod.path, size: mod.size, source: { kind: "url", file } });
          else skippedFiles.push(mod.path);
          continue;
        }
        const identified = known.get(mod.sha1.toLowerCase()) ?? null;
        const dto = base(`m:${mod.path}`, identified?.entry.title ?? mod.name, "modrinth");
        dto.fileName = mod.name;
        dto.size = mod.size;
        // A pack without `env` doesn't say; the catalog does (sodium, iris crash a server).
        dto.side = mod.side ?? identified?.side ?? null;
        dto.pageUrl = identified?.entry.pageUrl ?? mod.urls[0] ?? null;
        let reason: string | null = null;
        if (!ModStore.fitsFolder(folder, mod.name)) reason = `Its name doesn't fit ${label}, which takes ${patterns}.`;
        else if (url === null) reason = "Its download isn't on a host the panel may fetch from (MOD_CATALOG_HOSTS).";
        dto.downloadable = reason === null;
        dto.alreadyInstalled = names.has(mod.name) || (identified !== null && projects.has(`${identified.entry.provider}:${identified.entry.projectId}`));
        if (dto.downloadable && mod.side === "client") reason = "Client-only: the server doesn't need it.";
        else if (dto.downloadable && dto.side === "client") reason = clientOnly(identified!);
        dto.reason = reason;
        dto.selected = dto.downloadable && dto.side !== "client";
        entries.push({
          dto,
          source: dto.downloadable ? { kind: "url", file } : null,
          target: dto.downloadable ? `${folder.folder}/${mod.name}` : null,
          isMod: true,
          record: identified?.entry ?? null,
        });
      }
      else {
        const listed = cfVersions.get(mod.fileId) ?? null;
        const version = listed !== null && listed.projectId === mod.projectId ? listed : null; // Another project's file: treat as gone.
        const project = cfProjects.get(mod.projectId) ?? null;
        const dto = base(`c:${mod.projectId}:${mod.fileId}`, project?.title ?? `CurseForge project ${mod.projectId}`, "curseforge");
        dto.pageUrl = project?.pageUrl ?? `https://www.curseforge.com/projects/${encodeURIComponent(mod.projectId)}`;
        dto.fileName = version?.file.name ?? null;
        dto.size = version?.file.size ?? null;
        dto.alreadyInstalled = projects.has(`curseforge:${mod.projectId}`) || (version !== null && names.has(version.file.name));
        let reason: string | null = cfProblem;
        if (reason === null && (version === null || project?.downloadable === false)) {
          reason = "The author doesn't allow downloads outside CurseForge, or the file is gone. Download it from CurseForge and drop it into the folder.";
        }
        if (reason === null && !ModStore.fitsFolder(folder, version!.file.name)) reason = `Its file (${version!.file.name}) doesn't fit ${label}, which takes ${patterns}.`;
        dto.downloadable = reason === null;
        if (dto.downloadable && !mod.required) reason = "Optional in the pack.";
        dto.reason = reason;
        dto.selected = dto.downloadable && mod.required;
        entries.push({
          dto,
          source: dto.downloadable ? { kind: "catalog", version: version! } : null,
          target: dto.downloadable ? `${folder.folder}/${version!.file.name}` : null,
          isMod: true,
          record: dto.downloadable ? ModStore.catalogEntry("curseforge", project, version!, dto.title, []) : null,
        });
      }
    }
    if (mismatch !== null) {
      for (const entry of entries) {
        if (!entry.dto.downloadable || !entry.dto.selected) continue;
        entry.dto.selected = false;
        entry.dto.reason = mismatch;
      }
    }
    return entries;
  }

  /**
   * The SHA-1 of an included file, or null when it can't be read (the apply reports that file then).
   */
  async function hashOf(mod: ModPack.IncludedMod): Promise<string | null> {
    const hash = createHash("sha1");
    try {
      for await (const chunk of mod.open()) hash.update(chunk);
      return hash.digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Warnings when the pack was made for another game version or loader than the server runs.
   */
  function mismatches(parsed: ModPack.Parsed, gameVersion: string | null, catalogs: ModStore.CatalogRef[]): string[] {
    const warnings: string[] = [];
    if (parsed.gameVersion !== null && gameVersion !== null && parsed.gameVersion !== gameVersion) {
      warnings.push(`Made for game version ${parsed.gameVersion}; this server runs ${gameVersion}.`);
    }
    else if (parsed.gameVersion !== null && gameVersion === null) {
      warnings.push(`Made for game version ${parsed.gameVersion}; this server's version isn't known yet.`);
    }
    const ours = [...new Set(catalogs.flatMap((catalog) => catalog.ctx.loaders))];
    const theirs = parsed.loaders.map((loader) => loader.split(/[\s-]/)[0].toLowerCase()).filter((loader) => loader !== "" && loader !== "minecraft");
    if (ours.length > 0 && theirs.length > 0 && !theirs.some((loader) => ours.includes(loader))) {
      warnings.push(`Made for ${parsed.loaders.join(", ")}; this server runs ${ours.join(", ")}.`);
    }
    return warnings;
  }

  /**
   * Whether a pack path lies inside one of the override folders.
   */
  function isOverride(folders: string[], path: string): boolean {
    return folders.some((folder) => path.startsWith(`${folder}/`) && path.length > folder.length + 1);
  }
  //#endregion

  //#region Apply
  async function install(
    user: User,
    opened: ModStore.Opened,
    folder: ModFolder,
    plan: Plan,
    skip: Set<string>,
    include: Set<string>,
    withOverrides: boolean,
  ): Promise<Omit<ModInstallResponse, "mods"> & { overrides: number }> {
    const serverId = opened.server.id;
    const before = await ModStore.scan(user, serverId, folder);
    await ModStore.sweepUploads(user, serverId, before);
    const disabledDir = ModFolders.disabledFolder(folder);
    const entries = (await ModStore.readManifest(user, serverId)).manifest.folders[folder.key] ?? {};
    const installed: ModInstallResponse["installed"] = [];
    const skipped: ModInstallResponse["skipped"] = [];
    const recorded: { name: string; entry: ManifestEntry }[] = [];
    const toIdentify: { name: string; sha1: string }[] = [];
    const folders = new Set<string>();
    let fatal: unknown = null;

    const ensureParent = async (path: string) => {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent === "" || folders.has(parent)) return;
      await ModStore.ensureFolder(user, serverId, parent);
      folders.add(parent);
    };
    // A host or server problem (offline, timed out, deleting) ends the run; anything else skips the one file.
    const isFatal = (error: unknown) => ModStore.isHostProblem(opened, error);

    for (const entry of plan.entries) {
      const wanted = include.has(entry.dto.key) || (entry.dto.selected && !skip.has(entry.dto.key));
      if (!wanted) continue;
      if (entry.source === null || entry.target === null) {
        skipped.push({ title: entry.dto.title, reason: entry.dto.reason ?? "The panel can't get this file." });
        continue;
      }
      try {
        await ensureParent(entry.target);
        const stream = await open(entry.source);
        try {
          await FileService.upload(user, serverId, entry.target, true, stream.size, stream.stream);
        } catch (error) {
          stream.stream.cancel().catch(() => { });
          throw stream.failure() ?? error;
        }
        const name = entry.target.slice(entry.target.lastIndexOf("/") + 1);
        if (entry.isMod) {
          const stale = before.disabled.entries.some((candidate) => candidate.name === name) ? [`${disabledDir}/${name}`] : [];
          if (entry.record?.provider) {
            // An earlier file of the same project (another version) goes, like a catalog install.
            for (const [other, existing] of Object.entries(entries)) {
              if (other === name || existing.provider !== entry.record.provider || existing.projectId !== entry.record.projectId) continue;
              if (before.enabled.entries.some((candidate) => candidate.name === other)) stale.push(`${folder.folder}/${other}`);
              if (before.disabled.entries.some((candidate) => candidate.name === other)) stale.push(`${disabledDir}/${other}`);
            }
          }
          if (stale.length > 0) await ModStore.removeQuietly(user, serverId, stale);
          if (entry.record) recorded.push({ name, entry: { ...entry.record, installedAt: new Date().toISOString() } });
          else toIdentify.push({ name, sha1: stream.digests()!.sha1 });
        }
        installed.push({ name, title: entry.dto.title, versionNumber: entry.record?.versionNumber ?? "", dependency: false });
      } catch (error) {
        if (await isFatal(error)) {
          fatal = error;
          break;
        }
        skipped.push({ title: entry.dto.title, reason: (error as Error).message });
      }
    }

    let overrides = 0;
    if (withOverrides && fatal === null) {
      for (const file of plan.overrides) {
        try {
          await ensureParent(file.path);
          const stream = await open(file.source);
          try {
            await FileService.upload(user, serverId, file.path, true, stream.size, stream.stream);
          } catch (error) {
            stream.stream.cancel().catch(() => { });
            throw stream.failure() ?? error;
          }
          overrides++;
        } catch (error) {
          if (await isFatal(error)) {
            fatal = error;
            break;
          }
          skipped.push({ title: file.path, reason: (error as Error).message });
        }
      }
    }

    if (toIdentify.length > 0) {
      const catalogs = await ModStore.catalogsOf(opened, folder, await ModStore.version(user, opened).catch(() => null));
      const known = await ModStore.identify(catalogs, toIdentify.map((item) => item.sha1));
      for (const { name, sha1 } of toIdentify) recorded.push({ name, entry: known.get(sha1)?.entry ?? ModStore.unknownEntry(name, sha1) });
    }
    if (recorded.length > 0) {
      try {
        await ModStore.changeManifest(user, serverId, [await ModStore.scan(user, serverId, folder)], (manifest) => ModStore.record(manifest, folder.key, recorded));
      } catch (error) {
        if (fatal === null) throw error;
        console.error(`mods: server ${serverId}: the manifest couldn't be written after a failed pack import`, error);
      }
    }
    if (fatal !== null) throw fatal;
    return { installed, skipped, overrides };
  }

  async function open(source: Source): Promise<ModDownload.Verified & { size: number }> {
    if (source.kind === "url") return await ModDownload.open({ ...source.file, headers: {} });
    if (source.kind === "catalog") return await ModDownload.open(source.version.file);
    if (source.kind === "file") {
      const entry = source.entry;
      return { ...ModDownload.verify(entry.open(), { name: entry.path, size: entry.size, sha1: null, sha512: null }), size: entry.size };
    }
    const mod = source.mod;
    return { ...ModDownload.verify(mod.open(), { name: mod.name, size: mod.size, sha1: null, sha512: null }), size: mod.size };
  }
  //#endregion

  //#region Plans
  function store(plan: Plan): Plan {
    const mine = [..._plans.values()].filter((other) => other.userId === plan.userId && !other.busy).sort((a, b) => a.expiresAt - b.expiresAt);
    while (mine.length >= PLANS_PER_USER) void discard(mine.shift()!);
    plan.timer = setTimeout(() => {
      if (!plan.busy) void discard(plan);
    }, PLAN_TTL_MS);
    Deno.unrefTimer(plan.timer);
    _plans.set(plan.token, plan);
    return plan;
  }

  async function discard(plan: Plan): Promise<void> {
    clearTimeout(plan.timer);
    if (_plans.get(plan.token) === plan) _reservedBytes -= plan.bytes;
    _plans.delete(plan.token);
    await fsp.rm(plan.file, { force: true }).catch((error) => console.warn(`mods: the pack file ${plan.file} couldn't be removed: ${(error as Error).message}`));
  }

  function keyList(value: unknown, field: string): Set<string> {
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || value.length > 10000 || !value.every((item) => typeof item === "string")) throw HttpError.badRequest(`"${field}" must be a list of entry keys from the preview.`);
    return new Set(value as string[]);
  }
  //#endregion
}

export default ModPackService;
