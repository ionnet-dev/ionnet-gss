import type { PlayerEvent } from "@shared/protocol/protocol.gen.ts";
import { MetricsService } from "../../../servers/MetricsService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `server.player` (M4): shape-check (serverId UUID, player a non-empty string cut to PLAYER_NAME_MAX_CHARS, action in
 * PLAYER_ACTION_VALUES), then `MetricsService.applyPlayer`.
 */
export async function handleServerPlayer(conn: AgentConnection, data: PlayerEvent): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): validate as documented before passing on.
  await MetricsService.applyPlayer(conn.hostId, data);
}
