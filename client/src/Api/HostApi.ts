import type { OkResponse } from "@shared/api/common.ts";
import type {
  CreateEnrolTokenBody,
  CreateHostGrantBody,
  EnrolTokenCreatedResponse,
  EnrolTokenDto,
  HostDetailResponse,
  HostDto,
  HostGrantDto,
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

  /**
   * Ask the host's agent to update to the build the panel serves (M6). Progress arrives as `host.updated`.
   */
  export function updateAgent(id: string): Promise<HostDetailResponse> {
    return BaseApi.POST(`/hosts/${id}/agent/update`);
  }

  export function remove(id: string): Promise<OkResponse> {
    return BaseApi.DELETE(`/hosts/${id}`);
  }

  //#region Grants (M5)
  export function listGrants(id: string): Promise<HostGrantDto[]> {
    return BaseApi.GET(`/hosts/${id}/grants`);
  }

  export function addGrant(id: string, body: CreateHostGrantBody): Promise<HostGrantDto> {
    return BaseApi.POST(`/hosts/${id}/grants`, body);
  }

  export function removeGrant(id: string, userId: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/hosts/${id}/grants/${userId}`);
  }

  /**
   * A host's grants, refetched when `host.updated` names it.
   */
  export function useGrants(id: string) {
    return useResource(() => listGrants(id), [id], {
      liveEvents: ["host.updated"],
      liveFilter: (_event, data) => !("hostId" in data) || data.hostId === null || data.hostId === id,
    });
  }
  //#endregion

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
