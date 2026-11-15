import type { OkResponse } from "@shared/api/common.ts";
import type {
  CreateEnrolTokenBody,
  EnrolTokenCreatedResponse,
  EnrolTokenDto,
  HostDetailResponse,
  HostDto,
  UpdateHostBody,
} from "@shared/api/hosts.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/hosts` and `/api/enrol-tokens`.
 */
export namespace HostApi {
  export function list(): Promise<HostDto[]> {
    return BaseApi.GET("/hosts");
  }

  export function get(id: string): Promise<HostDetailResponse> {
    return BaseApi.GET(`/hosts/${id}`);
  }

  export function update(id: string, body: UpdateHostBody): Promise<HostDetailResponse> {
    return BaseApi.PATCH(`/hosts/${id}`, body);
  }

  export function remove(id: string): Promise<OkResponse> {
    return BaseApi.DELETE(`/hosts/${id}`);
  }

  //#region Enrol tokens
  export function listEnrolTokens(): Promise<EnrolTokenDto[]> {
    return BaseApi.GET("/enrol-tokens");
  }

  export function createEnrolToken(body: CreateEnrolTokenBody): Promise<EnrolTokenCreatedResponse> {
    return BaseApi.POST("/enrol-tokens", body);
  }

  export function revokeEnrolToken(id: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/enrol-tokens/${id}`);
  }
  //#endregion

  /**
   * Every visible host, refetched on `host.updated` and `host.status`.
   */
  export function useHosts() {
    return useResource(list, [], { liveEvents: ["host.updated", "host.status"] });
  }

  /**
   * One host, refetched when an event names it (or names no host), including the once-a-minute `host.facts`.
   */
  export function useHost(id: string) {
    return useResource(() => get(id), [id], {
      liveEvents: ["host.updated", "host.status", "host.facts"],
      liveFilter: (_event, data) => !("hostId" in data) || data.hostId === null || data.hostId === id,
    });
  }

  export function useEnrolTokens() {
    return useResource(listEnrolTokens, [], { liveEvents: ["enrolToken.updated"] });
  }
}

export default HostApi;
