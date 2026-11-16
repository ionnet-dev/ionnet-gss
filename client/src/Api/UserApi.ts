import type { OkResponse } from "@shared/api/common.ts";
import type {
  CreateUserBody,
  EffectiveQuotaDto,
  PasswordLinkSentResponse,
  RoleDto,
  SetUserPasswordBody,
  UpdateQuotaBody,
  UpdateUserBody,
  UpdateUserResponse,
  UserDto,
} from "@shared/api/users.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/users` and `/api/roles` (USERS_MANAGE).
 */
export namespace UserApi {
  export function list(): Promise<UserDto[]> {
    return BaseApi.GET("/users");
  }

  export function create(body: CreateUserBody): Promise<UserDto> {
    return BaseApi.POST("/users", body);
  }

  /**
   * `token` is set when the caller changed their own roles: store it with `useAuth().adoptSession()`.
   */
  export function update(id: number, body: UpdateUserBody): Promise<UpdateUserResponse> {
    return BaseApi.PATCH(`/users/${id}`, body);
  }

  export function setPassword(id: number, body: SetUserPasswordBody): Promise<OkResponse> {
    return BaseApi.POST(`/users/${id}/password`, body);
  }

  /**
   * M7: email the user a welcome link (no password yet) or a reset link.
   */
  export function sendPasswordLink(id: number): Promise<PasswordLinkSentResponse> {
    return BaseApi.POST(`/users/${id}/password-link`);
  }

  export function remove(id: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/users/${id}`);
  }

  //#region M5
  export function getQuota(id: number): Promise<EffectiveQuotaDto> {
    return BaseApi.GET(`/users/${id}/quota`);
  }

  export function setQuota(id: number, body: UpdateQuotaBody): Promise<EffectiveQuotaDto> {
    return BaseApi.PUT(`/users/${id}/quota`, body);
  }

  /**
   * Turn off a user's two-factor sign-in (lost phone and codes). Ends their sessions.
   */
  export function resetTotp(id: number): Promise<UserDto> {
    return BaseApi.POST(`/users/${id}/totp/reset`);
  }

  /**
   * One user's quota, refetched on `quota.updated` for that user.
   */
  export function useQuota(id: number) {
    return useResource(() => getQuota(id), [id], {
      liveEvents: ["quota.updated"],
      liveFilter: (_event, data) => !("userId" in data) || data.userId === id,
    });
  }
  //#endregion

  export function listRoles(): Promise<RoleDto[]> {
    return BaseApi.GET("/roles");
  }

  /**
   * Every user, refetched on `user.updated`.
   */
  export function useUsers() {
    return useResource(list, [], { liveEvents: ["user.updated"] });
  }

  export function useRoles() {
    return useResource(listRoles, []);
  }
}

export default UserApi;
