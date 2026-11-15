import type { OkResponse } from "@shared/api/common.ts";
import type { CreateInviteBody, InviteCreatedResponse, InviteDto } from "@shared/api/invites.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/invites` (INVITES_MANAGE).
 */
export namespace InviteApi {
  export function list(): Promise<InviteDto[]> {
    return BaseApi.GET("/invites");
  }

  export function create(body: CreateInviteBody): Promise<InviteCreatedResponse> {
    return BaseApi.POST("/invites", body);
  }

  export function revoke(id: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/invites/${id}`);
  }

  /**
   * Every invite, refetched on `invite.updated`.
   */
  export function useInvites() {
    return useResource(list, [], { liveEvents: ["invite.updated"] });
  }
}

export default InviteApi;
