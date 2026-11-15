import type { OkResponse } from "@shared/api/common.ts";
import type { CreateUserBody, RoleDto, SetUserPasswordBody, UpdateUserBody, UpdateUserResponse, UserDto } from "@shared/api/users.ts";
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

  export function remove(id: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/users/${id}`);
  }

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
