import type { DefinitionDto } from "@shared/api/definitions.ts";
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

  export function useDefinitions() {
    return useResource(list, []);
  }
}

export default DefinitionApi;
