import { PLAYER_ACTION_VALUES, PLAYER_NAME_MAX_CHARS, type PlayerEvent } from "@shared/protocol/protocol.gen.ts";
import { MetricsService } from "../../../servers/MetricsService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `server.player` (M4): shape-check (serverId UUID, player a non-empty string cut to PLAYER_NAME_MAX_CHARS, action in
 * PLAYER_ACTION_VALUES), then `MetricsService.applyPlayer`.
 */
export async function handleServerPlayer(conn: AgentConnection, data: PlayerEvent): Promise<void> {
  if (!conn.hostId) return;
  const event = requireObject<Partial<PlayerEvent>>(data, "server.player");
  if (typeof event.serverId !== "string" || !UUID_PATTERN.test(event.serverId)) throw new AgentRequestError("bad_request", "server.player needs a serverId (UUID).");
  if (typeof event.player !== "string" || event.player === "") throw new AgentRequestError("bad_request", "server.player needs a player name.");
  if (!PLAYER_ACTION_VALUES.includes(event.action as never)) throw new AgentRequestError("bad_request", `server.player has an unknown action "${String(event.action)}".`);
  await MetricsService.applyPlayer(conn.hostId, {
    serverId: event.serverId.toLowerCase(),
    player: event.player.slice(0, PLAYER_NAME_MAX_CHARS),
    action: event.action!,
    at: typeof event.at === "string" ? event.at : new Date().toISOString(),
  });
}
