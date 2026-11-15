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
import type { UpgradeServerBody, UpgradeServerResponse } from "@shared/api/servers.ts";
import { useEffect, useState } from "react";
import type { LiveEvents } from "@shared/live.ts";
import type { ServiceStatus } from "@shared/protocol/protocol.gen.ts";
import { useResource } from "@/hooks/useResource.ts";
import { liveSocket } from "@/live/LiveSocket.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * The newest `server.state` event per server id. Patches older than a fetched DTO are ignored by `applyState`.
 */
export type ServerStatePatches = Record<string, LiveEvents["server.state"]>;

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

  /**
   * Move to the latest (or the given) definition version (M3). Stopped only.
   */
  export function upgrade(id: string, body: UpgradeServerBody = {}): Promise<UpgradeServerResponse> {
    return BaseApi.POST(`/servers/${id}/upgrade`, body);
  }

  /**
   * Re-run steamcmd + the update hook (M3). Stopped only.
   */
  export function updateGame(id: string): Promise<GameServerDto> {
    return BaseApi.POST(`/servers/${id}/update`);
  }

  export function remove(id: string, keepData = false): Promise<OkResponse> {
    return BaseApi.DELETE(`/servers/${id}${keepData ? "?keepData=true" : ""}`);
  }

  /**
   * The newest `limit` console lines, or with `beforeSeq` the page before that line (`more` = older lines exist).
   */
  export function backlog(id: string, limit = 200, beforeSeq?: number): Promise<ConsoleBacklogResponse> {
    return BaseApi.GET(`/servers/${id}/console?limit=${limit}${beforeSeq ? `&before=${beforeSeq}` : ""}`);
  }

  export function sendInput(id: string, line: string): Promise<OkResponse> {
    return BaseApi.POST(`/servers/${id}/console`, { line });
  }

  /**
   * Overlay a `server.state` event on a server fetched earlier, unless the fetch is newer than the event.
   */
  export function applyState<T extends GameServerDto>(server: T, patch: LiveEvents["server.state"] | undefined): T {
    if (!patch || patch.serverId !== server.id) return server;
    if (new Date(patch.at).getTime() < new Date(server.stateChangedAt).getTime()) return server;
    return {
      ...server,
      state: patch.state,
      lastExitCode: patch.exitCode,
      stateReason: patch.reason,
      installProgress: patch.installProgress,
      stateChangedAt: patch.at,
    };
  }

  /**
   * Collect `server.state` events as they arrive (no refetch), keyed by server id, so pages update rows in place.
   * Pass `serverId` to keep only one server's events.
   */
  export function useStatePatches(serverId?: string): ServerStatePatches {
    const [patches, setPatches] = useState<ServerStatePatches>({});
    useEffect(() => {
      setPatches({});
      return liveSocket.on("server.state", (event) => {
        if (serverId !== undefined && event.serverId !== serverId) return;
        setPatches((current) => ({ ...current, [event.serverId]: event }));
      });
    }, [serverId]);
    return patches;
  }

  /**
   * Every visible server; refetched on `server.updated`. `server.state` is applied in place by the page.
   */
  export function useServers() {
    return useResource(list, [], { liveEvents: ["server.updated"] });
  }

  /**
   * The server's stack services, with `server.services` events applied in place. A refetch brings fresher figures
   * than an earlier event, so the event only holds until the server is fetched again.
   */
  export function useServices(server: GameServerDetailResponse | null): ServiceStatus[] {
    const [live, setLive] = useState<{ base: ServiceStatus[]; services: ServiceStatus[] } | null>(null);
    const serverId = server?.id;
    const base = server?.services;
    useEffect(() => {
      if (!serverId || !base) return;
      return liveSocket.on("server.services", (event) => {
        if (event.serverId === serverId) setLive({ base, services: event.services });
      });
    }, [serverId, base]);
    if (!base) return [];
    return live && live.base === base ? live.services : base;
  }

  /**
   * One server; refetched on `server.updated` and when a sync brings a newer definition ("update available").
   */
  export function useServer(id: string) {
    return useResource(() => get(id), [id], {
      liveEvents: ["server.updated", "definitions.updated"],
      liveFilter: (_event, data) => !("serverId" in data) || data.serverId === null || data.serverId === id,
    });
  }
}

export default ServerApi;
