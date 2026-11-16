import type { BackupDto, BackupListResponse, CreateBackupBody, RestoreBackupResponse } from "@shared/api/backups.ts";
import type { OkResponse } from "@shared/api/common.ts";
import type { DownloadTicketResponse } from "@shared/api/files.ts";
import type { LiveEvents } from "@shared/live.ts";
import { useEffect, useState } from "react";
import { liveSocket } from "@/live/LiveSocket.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/backups` (M4).
 */
export namespace BackupApi {
  export function list(serverId: string): Promise<BackupListResponse> {
    return BaseApi.GET(`/servers/${serverId}/backups`);
  }

  export function create(serverId: string, body: CreateBackupBody = {}): Promise<BackupDto> {
    return BaseApi.POST(`/servers/${serverId}/backups`, body);
  }

  export function remove(serverId: string, backupId: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/servers/${serverId}/backups/${backupId}`);
  }

  export function restore(serverId: string, backupId: number): Promise<RestoreBackupResponse> {
    return BaseApi.POST(`/servers/${serverId}/backups/${backupId}/restore`);
  }

  export function downloadTicket(serverId: string, backupId: number): Promise<DownloadTicketResponse> {
    return BaseApi.POST(`/servers/${serverId}/backups/${backupId}/download`);
  }

  /**
   * The list, refetched on `backup.updated` for this server.
   */
  export function useBackups(serverId: string) {
    return useResource(() => list(serverId), [serverId], {
      liveEvents: ["backup.updated"],
      liveFilter: (_event, data) => (data as LiveEvents["backup.updated"]).serverId === serverId,
    });
  }

  /**
   * The newest `backup.progress` of the server (topic `server:<id>`), or null; cleared when the list refetches.
   */
  export function useProgress(serverId: string): LiveEvents["backup.progress"] | null {
    const [progress, setProgress] = useState<LiveEvents["backup.progress"] | null>(null);
    useEffect(() => {
      setProgress(null);
      const offTopic = liveSocket.subscribeTopic(`server:${serverId}`);
      const offProgress = liveSocket.on("backup.progress", (data) => {
        if (data.serverId === serverId) setProgress(data);
      });
      const offUpdated = liveSocket.on("backup.updated", (data) => {
        if (data.serverId === serverId) setProgress(null);
      });
      return () => {
        offTopic();
        offProgress();
        offUpdated();
      };
    }, [serverId]);
    return progress;
  }
}

export default BackupApi;
