import type { OkResponse } from "@shared/api/common.ts";
import type { CreateShareBody, ServerShareDto, UpdateShareBody } from "@shared/api/servers.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/shares` (M5). Owner level, except `remove` of your own share.
 */
export namespace ShareApi {
  export function list(serverId: string): Promise<ServerShareDto[]> {
    return BaseApi.GET(`/servers/${serverId}/shares`);
  }

  export function add(serverId: string, body: CreateShareBody): Promise<ServerShareDto> {
    return BaseApi.POST(`/servers/${serverId}/shares`, body);
  }

  export function update(serverId: string, userId: number, body: UpdateShareBody): Promise<ServerShareDto> {
    return BaseApi.PATCH(`/servers/${serverId}/shares/${userId}`, body);
  }

  export function remove(serverId: string, userId: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/servers/${serverId}/shares/${userId}`);
  }

  /**
   * A server's shares, refetched when `server.updated` names it.
   */
  export function useShares(serverId: string) {
    return useResource(() => list(serverId), [serverId], {
      liveEvents: ["server.updated"],
      liveFilter: (_event, data) => !("serverId" in data) || data.serverId === null || data.serverId === serverId,
    });
  }
}

export default ShareApi;
