import type { ConsoleBatch } from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `server.console`: shape-check the batch, then forward its lines to the live topic. The agent keeps batches within
 * CONSOLE_BATCH_MAX_LINES / CONSOLE_BATCH_MAX_BYTES (the frame limit bounds them anyway); a malformed line is
 * skipped and an over-long one cut to CONSOLE_LINE_MAX_BYTES, so one bad line never costs the batch.
 */
export async function handleServerConsole(conn: AgentConnection, data: ConsoleBatch): Promise<void> {
  if (!conn.hostId) return;
  const batch = requireObject<Partial<ConsoleBatch>>(data, "server.console");
  if (typeof batch.serverId !== "string" || !UUID_PATTERN.test(batch.serverId)) throw new AgentRequestError("bad_request", "server.console needs a serverId (UUID).");
  if (!Array.isArray(batch.lines)) throw new AgentRequestError("bad_request", "server.console needs a list of lines.");
  const lines = GameServerService.sanitizeLines(batch.lines);
  if (lines.length < batch.lines.length) console.warn(`host ${conn.hostId} sent ${batch.lines.length - lines.length} malformed console line(s) for ${batch.serverId}; skipped`);
  if (lines.length === 0) return;
  GameServerService.forwardConsole(conn.hostId, { serverId: batch.serverId.toLowerCase(), lines });
}
