/**
 * `/api/servers/:id/mods`: the Mods tab, built from the definition's `mods` folders that apply to the server (`when`).
 * Access: `manage` (like files); 404 otherwise, and 404 when no folder applies. Everything goes through the agent's file
 * API, so the host must be online (409). `:folder` is a `ModFolder.key`. Changes apply at the game's next start.
 *
 * What a mod is comes from the folder alone: an entry of `folder` (enabled) or `disabledFolder` (disabled) whose name
 * matches `match`. Disabling moves the entry to `disabledFolder`, enabling moves it back. The panel keeps what it
 * knows about catalog installs in the manifest `gss-mods.json` (data root, travels with backups); entries nobody
 * installed through the panel (dropped in through Files, SFTP…) simply have no `info`.
 */
import type { IsoDate } from "./common.ts";
import type { ModCatalogProvider, ModPackFormat } from "../protocol/protocol.gen.ts";

/**
 * `GET /api/servers/:id/mods`.
 */
export interface ModsResponse {
  /**
   * The installed game version (`game_version`), which catalogs filter by; null when unknown (catalog search and
   * install then answer 409 "install the server first").
   */
  version: string | null;
  folders: ModFolderDto[];
}

export interface ModFolderDto {
  key: string;
  label: string; // The key when the definition has none.
  description: string | null;
  folder: string; // e.g. "mods"
  disabledFolder: string; // e.g. "mods.disabled"
  match: string[]; // The definition's patterns; uploads must match one without a trailing "/".
  catalogs: ModCatalogDto[]; // In the definition's order; empty when the folder has none.
  packs: ModPackFormat[]; // Pack formats the folder imports; empty = no import.
  /**
   * Enabled first, then disabled, each by name (case-insensitive). At most FILES_LIST_MAX_ENTRIES per folder.
   */
  mods: ModDto[];
  /**
   * Why updates couldn't be checked (a catalog down), naming the catalog; null when they were, or there is none.
   */
  updatesError: string | null;
}

export interface ModCatalogDto {
  provider: ModCatalogProvider;
  label: string; // e.g. "Modrinth", "CurseForge"
  projectType: string; // e.g. "mod", "mc-mods"
  loaders: string[]; // Rendered, e.g. ["neoforge"].
  /**
   * False when the panel can't use it (CurseForge without an API key): the tab shows `unavailableReason` instead of
   * search, and the catalog routes answer 409 with it.
   */
  available: boolean;
  unavailableReason: string | null; // e.g. "An administrator needs to add a CurseForge API key under Settings → Mod catalogs."
}

export interface ModDto {
  name: string; // Entry name in the folder, e.g. "jei-1.21.1-neoforge-19.21.0.247.jar"; a folder has no slash.
  enabled: boolean;
  isFolder: boolean;
  size: number | null; // Bytes; null for folders.
  modifiedAt: IsoDate;
  info: ModInfoDto | null; // From the manifest: installed from a catalog or a pack, or an upload a catalog recognised.
  update: ModUpdateDto | null; // A newer compatible version in the catalog.
}

export interface ModInfoDto {
  /**
   * Where the file is from: a catalog, or null for an upload no catalog recognised by its SHA-1 (then `projectId` and
   * `versionId` are null and `title` is the file name).
   */
  provider: ModCatalogProvider | null;
  projectId: string | null;
  versionId: string | null;
  title: string;
  versionNumber: string | null;
  iconUrl: string | null;
  pageUrl: string | null;
  installedAt: IsoDate;
  /**
   * Titles of the mods that pulled this one in as a required dependency; empty when it was installed directly.
   */
  requiredBy: string[];
}

export interface ModUpdateDto {
  versionId: string;
  versionNumber: string;
  publishedAt: IsoDate;
}

/**
 * `POST` (or `PUT`, as `BaseApi.UPLOAD` sends) `/api/servers/:id/mods/:folder/upload?name=<file>&overwrite=1` with the
 * raw file as the body (streamed, like
 * file uploads; UPLOAD_MAX_MB). `name` must be a plain file name matching one of the folder's file patterns (400),
 * and new unless `overwrite` (409, message contains "already exists"). Lands in `folder` (enabled); an entry of that
 * name in `disabledFolder` is removed when overwriting. The panel hashes the file while relaying it and asks the
 * folder's catalogs to recognise it by SHA-1 (best effort): a match gets catalog `info` (title, version, updates).
 * Response: the new `ModDto`.
 */
export type UploadModResponse = ModDto;

/**
 * `POST /api/servers/:id/mods/:folder/state`: move entries between `folder` and `disabledFolder`. Names must be listed
 * mods (400); one already in the target state is skipped; a name taken in the target folder is a 409. Response:
 * `OkResponse`.
 */
export interface SetModStateBody {
  names: string[]; // At most FILES_DELETE_MAX_PATHS.
  enabled: boolean;
}

/**
 * `POST /api/servers/:id/mods/:folder/delete`: delete entries (files, or folders with their contents) from either
 * folder, and their manifest entries. Names must be listed mods (400). Response: `OkResponse`.
 */
export interface DeleteModsBody {
  names: string[]; // At most FILES_DELETE_MAX_PATHS.
}

/**
 * `GET /api/servers/:id/mods/:folder/catalog/:provider/search?query=&offset=&limit=` (limit ≤ 50, default 20): projects of the
 * folder's `projectType` for its loaders and the server's game version, server-side ones only (client-only mods are
 * left out where the catalog knows). 404 when the folder has no such catalog, 409 when it is unavailable or the game
 * version is unknown, 429 when the catalog rate limits the panel, 502 when it fails.
 */
export interface ModSearchResponse {
  hits: ModSearchHitDto[];
  total: number;
  offset: number;
}

export interface ModSearchHitDto {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl: string | null;
  pageUrl: string;
  downloads: number;
  installed: boolean; // A mod of this project is in the manifest of this folder (enabled or disabled).
  /**
   * False when the author doesn't allow downloads outside the catalog's own app (CurseForge): Install is refused, and
   * the owner downloads it from `pageUrl` and drops it in.
   */
  downloadable: boolean;
}

/**
 * `GET /api/servers/:id/mods/:folder/catalog/:provider/projects/:projectId/versions`: the versions compatible with the server,
 * newest first (at most 50). A plain array. Versions whose file the panel can't download are left out.
 */
export interface ModVersionDto {
  versionId: string;
  name: string;
  versionNumber: string;
  publishedAt: IsoDate;
  fileName: string;
  size: number;
  dependencies: ModDependencyDto[];
}

export interface ModDependencyDto {
  projectId: string | null;
  versionId: string | null; // A pinned version, when the catalog names one.
  title: string | null; // Filled for required and incompatible ones when the catalog could be asked.
  type: "required" | "optional" | "incompatible" | "embedded";
}

/**
 * `POST /api/servers/:id/mods/:folder/install`: download from the catalog (hash verified before the file is committed)
 * into `folder`, record it in the manifest, and with `dependencies` (default true) also every required dependency that
 * isn't installed yet (newest compatible version, or the pinned one), recursively. A mod of the same project already
 * installed is replaced (its old file removed). 409 when the game version is unknown or a compatible version is
 * missing; 502 when the catalog or the download fails (nothing is half-written: files already installed stay).
 */
export interface InstallModBody {
  provider: ModCatalogProvider; // One of the folder's available catalogs.
  projectId: string;
  versionId?: string | null; // Default: the newest compatible version.
  dependencies?: boolean;
}

/**
 * `POST /api/servers/:id/mods/:folder/update`: install each named mod's `update` (same rules as install, dependencies
 * included). Names without an update are skipped.
 */
export interface UpdateModsBody {
  names: string[];
}

export interface ModInstallResponse {
  installed: { name: string; title: string; versionNumber: string; dependency: boolean }[];
  skipped: { title: string; reason: string }[]; // e.g. an incompatible dependency, or "already installed".
  mods: ModsResponse; // Fresh state.
}

/**
 * `POST` (or `PUT`) `/api/servers/:id/mods/:folder/packs?name=<file>` with the raw pack as the body (a `.mrpack`, a
 * CurseForge export `.zip` or its `manifest.json`, or any `.zip` of mod files; at most MOD_PACK_MAX_MB): parse it and
 * answer a preview without changing anything. 400 when the folder doesn't import that format or the file isn't one;
 * 413 over the limit. The parsed pack is kept for `apply` under `token` (per user, 30 minutes, panel memory).
 */
export interface ModPackPreviewDto {
  token: string;
  format: ModPackFormat;
  name: string; // The pack's name, or the file name.
  version: string | null; // The pack's own version.
  gameVersion: string | null; // The game version it was made for.
  loaders: string[]; // e.g. ["neoforge 21.1.77"].
  /**
   * Readable mismatches and limits, e.g. "Made for Minecraft 1.20.1; this server runs 1.21.1.", "3 mods can't be
   * downloaded by the panel: download them yourself and drop them in.", "CurseForge profiles can contain client-only
   * mods; disable any that stop the server from starting."
   */
  warnings: string[];
  mods: ModPackEntryDto[];
  overrides: {
    count: number; // Files the pack writes below the definition's `packs.overrides` folders.
    bytes: number;
    sample: string[]; // Up to 20 of their paths.
    skipped: string[]; // Up to 20 paths outside those folders (left out).
  };
  expiresAt: IsoDate;
}

export interface ModPackEntryDto {
  key: string; // Stable within this preview; what `skip` names.
  title: string; // Catalog title when known, else the file name, else "CurseForge project <id>".
  fileName: string | null;
  size: number | null;
  source: "included" | ModCatalogProvider; // Inside the pack, or downloaded from that catalog.
  pageUrl: string | null; // Where the owner can download it by hand.
  side: "server" | "client" | "both" | null; // From the pack when it says (mrpack `env`); null = unknown.
  /**
   * The panel can get the file (included, or a catalog download it may make). False: listed with `reason` and
   * `pageUrl`, never installed by `apply`.
   */
  downloadable: boolean;
  reason: string | null; // Why not downloadable, or why it is skipped by default (client-only).
  selected: boolean; // Installed by `apply` unless named in `skip` (client-only and not downloadable start false).
  alreadyInstalled: boolean; // The same project or file name is already in the folder.
}

/**
 * `POST /api/servers/:id/mods/:folder/packs/:token/apply`: install the pack's selected mods into `folder` (downloads
 * hash-checked where the pack or catalog has hashes) and, with `overrides`, write its override files (replacing
 * existing ones). 404 when the token is unknown or expired (upload the pack again).
 */
export interface ApplyModPackBody {
  skip?: string[]; // Entry keys to leave out, on top of the unselected ones.
  include?: string[]; // Entry keys to install although not selected by default (client-only ones).
  overrides?: boolean; // Default true.
}
