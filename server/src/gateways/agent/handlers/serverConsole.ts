import type { ConsoleBatch } from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `server.console`: shape-check (≤ 500 lines per batch, each text ≤ 8 KiB), then forward to the live topic.
 */
export async function handleServerConsole(conn: AgentConnection, data: ConsoleBatch): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): C — validate the payload before forwarding.
  GameServerService.forwardConsole(conn.hostId, data);
}
