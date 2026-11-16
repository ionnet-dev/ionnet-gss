import type { DefinitionDto, VariableOptionsResponse } from "@shared/api/definitions.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/definitions`: the games for the create flow.
 */
export namespace DefinitionApi {
  export function list(): Promise<DefinitionDto[]> {
    return BaseApi.GET("/definitions");
  }

  export function get(id: number): Promise<DefinitionDto> {
    return BaseApi.GET(`/definitions/${id}`);
  }

  /**
   * The current list of an `options_from` select (M3). `values` holds the current values of the variables the list
   * depends on.
   */
  export function getOptions(id: number, key: string, values?: URLSearchParams): Promise<VariableOptionsResponse> {
    const query = values?.toString() ?? "";
    return BaseApi.GET(`/definitions/${id}/options/${encodeURIComponent(key)}${query === "" ? "" : `?${query}`}`);
  }

  /**
   * Every active definition, refetched when a source sync changes them.
   */
  export function useDefinitions() {
    return useResource(list, [], { liveEvents: ["definitions.updated"] });
  }
}

export default DefinitionApi;
