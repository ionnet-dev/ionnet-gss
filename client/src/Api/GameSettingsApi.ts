import type { GameSettingsResponse, UpdateGameSettingsBody, UpdateGameSettingsResponse } from "@shared/api/gameSettings.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/game-settings`: the keys of the game's config files from its definition's `settings` block. No live
 * events: the tab refetches on mount and after its own save.
 */
export namespace GameSettingsApi {
  export function get(serverId: string): Promise<GameSettingsResponse> {
    return BaseApi.GET(`/servers/${serverId}/game-settings`);
  }

  /**
   * Write the changed keys. 409 when a file changed since it was loaded; 400 names the field at fault.
   */
  export function update(serverId: string, body: UpdateGameSettingsBody): Promise<UpdateGameSettingsResponse> {
    return BaseApi.PUT(`/servers/${serverId}/game-settings`, body);
  }

  /**
   * The settings of the server's config files. Call `reload()` after a change.
   */
  export function useGameSettings(serverId: string) {
    return useResource(() => get(serverId), [serverId]);
  }
}
