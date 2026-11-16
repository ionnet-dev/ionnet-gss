import type { OkResponse } from "@shared/api/common.ts";
import type {
  ApplyModPackBody,
  ModInstallResponse,
  ModPackPreviewDto,
  ModsResponse,
  ModSearchResponse,
  ModVersionDto,
  UploadModResponse,
} from "@shared/api/mods.ts";
import type { ModCatalogProvider } from "@shared/protocol/protocol.gen.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/mods`: the Mods tab's folders, uploads, enable/disable, delete and catalog installs. No live
 * events: the tab refetches on mount and after its own changes.
 */
export namespace ModApi {
  export interface UploadOptions {
    /**
     * Replace a mod of the same name (a 409 otherwise).
     */
    overwrite?: boolean;
    /**
     * Bytes sent so far and the total.
     */
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  }

  function base(serverId: string, folder: string): string {
    return `/servers/${serverId}/mods/${encodeURIComponent(folder)}`;
  }

  export function list(serverId: string): Promise<ModsResponse> {
    return BaseApi.GET(`/servers/${serverId}/mods`);
  }

  /**
   * Send a file as the raw body into the folder (enabled). 400 when its name matches none of the folder's patterns,
   * 409 when a mod of that name exists and `overwrite` is off.
   */
  export function upload(serverId: string, folder: string, file: File, opts?: UploadOptions): Promise<UploadModResponse> {
    const query = `name=${encodeURIComponent(file.name)}${opts?.overwrite ? "&overwrite=1" : ""}`;
    return BaseApi.UPLOAD(`${base(serverId, folder)}/upload?${query}`, file, opts?.onProgress, opts?.signal);
  }

  /**
   * Move entries between the folder and its disabled folder.
   */
  export function setState(serverId: string, folder: string, names: string[], enabled: boolean): Promise<OkResponse> {
    return BaseApi.POST(`${base(serverId, folder)}/state`, { names, enabled });
  }

  export function remove(serverId: string, folder: string, names: string[]): Promise<OkResponse> {
    return BaseApi.POST(`${base(serverId, folder)}/delete`, { names });
  }

  /**
   * Projects of one of the folder's catalogs for the server's game version; an empty `query` lists the popular ones.
   * 409 when the catalog is unavailable or the game version is unknown.
   */
  export function search(serverId: string, folder: string, provider: ModCatalogProvider, query: string, offset: number, limit = 20): Promise<ModSearchResponse> {
    return BaseApi.GET(`${base(serverId, folder)}/catalog/${provider}/search?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`);
  }

  export function versions(serverId: string, folder: string, provider: ModCatalogProvider, projectId: string): Promise<ModVersionDto[]> {
    return BaseApi.GET(`${base(serverId, folder)}/catalog/${provider}/projects/${encodeURIComponent(projectId)}/versions`);
  }

  /**
   * Install a project from a catalog (the newest compatible version unless `versionId` is given), with its required
   * dependencies unless `dependencies` is false.
   */
  export function install(serverId: string, folder: string, provider: ModCatalogProvider, projectId: string, versionId?: string | null, dependencies = true): Promise<ModInstallResponse> {
    return BaseApi.POST(`${base(serverId, folder)}/install`, { provider, projectId, versionId: versionId ?? null, dependencies });
  }

  /**
   * Install the available update of each named mod.
   */
  export function update(serverId: string, folder: string, names: string[]): Promise<ModInstallResponse> {
    return BaseApi.POST(`${base(serverId, folder)}/update`, { names });
  }

  /**
   * Send a modpack file (`.mrpack`, a CurseForge export or `manifest.json`, a `.zip`) for a preview; nothing is changed
   * until `applyPack`. 400 when the folder doesn't import that format.
   */
  export function uploadPack(serverId: string, folder: string, file: File, opts?: Pick<UploadOptions, "onProgress" | "signal">): Promise<ModPackPreviewDto> {
    return BaseApi.UPLOAD(`${base(serverId, folder)}/packs?name=${encodeURIComponent(file.name)}`, file, opts?.onProgress, opts?.signal);
  }

  /**
   * Install a previewed pack. 404 when its token expired (upload the pack again).
   */
  export function applyPack(serverId: string, folder: string, token: string, body: ApplyModPackBody): Promise<ModInstallResponse> {
    return BaseApi.POST(`${base(serverId, folder)}/packs/${encodeURIComponent(token)}/apply`, body);
  }

  /**
   * The server's mod folders and their mods. Call `reload()` after a change.
   */
  export function useMods(serverId: string) {
    return useResource(() => list(serverId), [serverId]);
  }
}
