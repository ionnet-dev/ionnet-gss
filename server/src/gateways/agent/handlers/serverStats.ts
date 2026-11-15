import type { StatsBatch } from "@shared/protocol/protocol.gen.ts";
import { MetricsService } from "../../../servers/MetricsService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `server.stats` (M4): shape-check (array of at most 1000 `ServerStats`, serverId UUID, finite non-negative numbers,
 * `diskBytes` integer or null; bad entries are skipped, not the batch), then `MetricsService.recordStats`.
 */
export async function handleServerStats(conn: AgentConnection, data: StatsBatch): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): validate as documented before passing on.
  await MetricsService.recordStats(conn.hostId, data);
}
