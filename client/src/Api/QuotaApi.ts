import type { EffectiveQuotaDto } from "@shared/api/users.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/quota` (M5): the signed-in user's own quota and usage. Other users': `UserApi.getQuota`.
 */
export namespace QuotaApi {
  export function mine(): Promise<EffectiveQuotaDto> {
    return BaseApi.GET("/quota");
  }

  /**
   * Own quota, refetched when limits change (`quota.updated`) or usage may have (`server.updated`, `backup.updated`).
   */
  export function useMine() {
    return useResource(mine, [], { liveEvents: ["quota.updated", "server.updated", "backup.updated"] });
  }
}

export default QuotaApi;
