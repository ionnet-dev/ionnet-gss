import type { StateChange } from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `server.state`: shape-check (requireObject, serverId UUID, state in SERVER_STATE_VALUES), then
 * `GameServerService.applyStateChange(conn.hostId, data)`.
 */
export async function handleServerState(conn: AgentConnection, data: StateChange): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): C — validate the payload before applying.
  await GameServerService.applyStateChange(conn.hostId, data);
}
