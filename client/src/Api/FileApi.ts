import type { OkResponse } from "@shared/api/common.ts";
import type { DownloadTicketResponse, FileContentResponse, FileEntryDto, FileListResponse } from "@shared/api/files.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/files` (M4). Paths are relative to the data folder, `""` = its root. No live events: the file
 * manager refetches after its own changes and on a manual refresh.
 */
export namespace FileApi {
  export function list(serverId: string, path: string): Promise<FileListResponse> {
    return BaseApi.GET(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
  }

  /**
   * The listing of one folder, loaded again when `path` changes. There are no live events: call `reload()` after a
   * change.
   */
  export function useFiles(serverId: string, path: string) {
    return useResource(() => list(serverId, path), [serverId, path]);
  }

  export function read(serverId: string, path: string): Promise<FileContentResponse> {
    return BaseApi.GET(`/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`);
  }

  /**
   * Save editor text. `modifiedAt` = the loaded entry's (409 when the file changed since); omit to overwrite.
   */
  export function save(serverId: string, path: string, content: string, modifiedAt?: string): Promise<FileEntryDto> {
    const query = `path=${encodeURIComponent(path)}${modifiedAt ? `&modifiedAt=${encodeURIComponent(modifiedAt)}` : ""}`;
    return BaseApi.PUT_TEXT(`/servers/${serverId}/files/content?${query}`, content);
  }

  export function createFolder(serverId: string, path: string): Promise<FileEntryDto> {
    return BaseApi.POST(`/servers/${serverId}/files/folder`, { path });
  }

  export function rename(serverId: string, from: string, to: string, overwrite = false): Promise<FileEntryDto> {
    return BaseApi.POST(`/servers/${serverId}/files/rename`, { from, to, overwrite });
  }

  export function remove(serverId: string, paths: string[]): Promise<OkResponse> {
    return BaseApi.POST(`/servers/${serverId}/files/delete`, { paths });
  }

  export function upload(serverId: string, path: string, file: Blob, overwrite: boolean, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<FileEntryDto> {
    return BaseApi.UPLOAD(`/servers/${serverId}/files/upload?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=true" : ""}`, file, onProgress, signal);
  }

  /**
   * A single-use link; open it with `startDownload` so the browser downloads it itself.
   */
  export function downloadTicket(serverId: string, path: string): Promise<DownloadTicketResponse> {
    return BaseApi.POST(`/servers/${serverId}/files/download`, { path });
  }

  /**
   * Hand a ticket URL to the browser's download manager (a temporary `<a download>` click; no page navigation).
   */
  export function startDownload(ticket: DownloadTicketResponse): void {
    const link = document.createElement("a");
    link.href = ticket.url;
    link.download = ""; // The panel's Content-Disposition names the file.
    link.rel = "noopener";
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

export default FileApi;
