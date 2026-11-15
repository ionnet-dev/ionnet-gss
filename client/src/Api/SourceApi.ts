import type { OkResponse } from "@shared/api/common.ts";
import type { CreateSourceBody, SourceDto, SyncSourceResponse, UpdateSourceBody } from "@shared/api/sources.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/sources` (SOURCES_MANAGE, M3).
 */
export namespace SourceApi {
  export function list(): Promise<SourceDto[]> {
    return BaseApi.GET("/sources");
  }

  export function create(body: CreateSourceBody): Promise<SourceDto> {
    return BaseApi.POST("/sources", body);
  }

  export function update(id: number, body: UpdateSourceBody): Promise<SourceDto> {
    return BaseApi.PATCH(`/sources/${id}`, body);
  }

  export function remove(id: number): Promise<OkResponse> {
    return BaseApi.DELETE(`/sources/${id}`);
  }

  export function sync(id: number): Promise<SyncSourceResponse> {
    return BaseApi.POST(`/sources/${id}/sync`);
  }

  /**
   * Every source, refetched on `source.updated`.
   */
  export function useSources() {
    return useResource(list, [], { liveEvents: ["source.updated"] });
  }
}

export default SourceApi;
