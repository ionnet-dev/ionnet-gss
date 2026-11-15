import type { OkResponse } from "@shared/api/common.ts";
import type {
  ConsoleBacklogResponse,
  CreateServerBody,
  GameServerDetailResponse,
  GameServerDto,
  StopServerBody,
  UpdateServerBody,
  UpdateServerResponse,
} from "@shared/api/servers.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers`.
 */
export namespace ServerApi {
  export function list(): Promise<GameServerDto[]> {
    return BaseApi.GET("/servers");
  }

  export function get(id: string): Promise<GameServerDetailResponse> {
    return BaseApi.GET(`/servers/${id}`);
  }

  export function create(body: CreateServerBody): Promise<GameServerDetailResponse> {
    return BaseApi.POST("/servers", body);
  }

  export function update(id: string, body: UpdateServerBody): Promise<UpdateServerResponse> {
    return BaseApi.PATCH(`/servers/${id}`, body);
  }

  export function start(id: string): Promise<GameServerDto> {
    return BaseApi.POST(`/servers/${id}/start`);
  }

  export function stop(id: string, body: StopServerBody = {}): Promise<GameServerDto> {
    return BaseApi.POST(`/servers/${id}/stop`, body);
  }

  export function restart(id: string): Promise<GameServerDto> {
    return BaseApi.POST(`/servers/${id}/restart`);
  }

  export function reinstall(id: string): Promise<GameServerDto> {
    return BaseApi.POST(`/servers/${id}/reinstall`);
  }

  export function remove(id: string, keepData = false): Promise<OkResponse> {
    return BaseApi.DELETE(`/servers/${id}${keepData ? "?keepData=true" : ""}`);
  }

  export function backlog(id: string, limit = 200): Promise<ConsoleBacklogResponse> {
    return BaseApi.GET(`/servers/${id}/console?limit=${limit}`);
  }

  export function sendInput(id: string, line: string): Promise<OkResponse> {
    return BaseApi.POST(`/servers/${id}/console`, { line });
  }

  /**
   * Every visible server; refetched on `server.updated`. `server.state` is applied in place by the page.
   */
  export function useServers() {
    return useResource(list, [], { liveEvents: ["server.updated"] });
  }

  export function useServer(id: string) {
    return useResource(() => get(id), [id], {
      liveEvents: ["server.updated"],
      liveFilter: (_event, data) => !("serverId" in data) || data.serverId === null || data.serverId === id,
    });
  }
}

export default ServerApi;
