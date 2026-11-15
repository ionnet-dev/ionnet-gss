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
   * The current list of an `options_from` select (M3).
   */
  export function getOptions(id: number, key: string): Promise<VariableOptionsResponse> {
    return BaseApi.GET(`/definitions/${id}/options/${encodeURIComponent(key)}`);
  }

  export function useDefinitions() {
    return useResource(list, []);
  }
}

export default DefinitionApi;
