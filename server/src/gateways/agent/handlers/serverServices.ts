import type { ServicesChange } from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `server.services` (M3): shape-check (serverId UUID, ≤ 4 services, name/image strings ≤ 255, state in
 * SERVICE_STATE_VALUES), then `GameServerService.applyServicesChange`.
 */
export async function handleServerServices(conn: AgentConnection, data: ServicesChange): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): C — validate the payload before applying.
  await GameServerService.applyServicesChange(conn.hostId, data);
}
