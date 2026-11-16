import type { ServerStats, StatsBatch } from "@shared/protocol/protocol.gen.ts";
import { MetricsService } from "../../../servers/MetricsService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SERVERS = 1000;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * `server.stats` (M4): shape-check (array of at most 1000 `ServerStats`, serverId UUID, finite non-negative numbers,
 * `diskBytes` integer or null; bad entries are skipped, not the batch), then `MetricsService.recordStats`.
 */
export async function handleServerStats(conn: AgentConnection, data: StatsBatch): Promise<void> {
  if (!conn.hostId) return;
  const batch = requireObject<Partial<StatsBatch>>(data, "server.stats");
  if (!Array.isArray(batch.servers)) throw new AgentRequestError("bad_request", "server.stats needs a servers list.");
  const servers: ServerStats[] = [];
  for (const raw of batch.servers.slice(0, MAX_SERVERS) as Partial<ServerStats>[]) {
    if (typeof raw !== "object" || raw === null) continue;
    if (typeof raw.serverId !== "string" || !UUID_PATTERN.test(raw.serverId)) continue;
    if (![raw.cpuPercent, raw.memoryBytes, raw.memoryLimitBytes, raw.netRxBytes, raw.netTxBytes, raw.pids].every(isCount)) continue;
    const diskBytes = raw.diskBytes ?? null;
    if (diskBytes !== null && !(Number.isSafeInteger(diskBytes) && diskBytes >= 0)) continue;
    servers.push({
      serverId: raw.serverId.toLowerCase(),
      cpuPercent: raw.cpuPercent!,
      memoryBytes: raw.memoryBytes!,
      memoryLimitBytes: raw.memoryLimitBytes!,
      netRxBytes: raw.netRxBytes!,
      netTxBytes: raw.netTxBytes!,
      pids: raw.pids!,
      diskBytes,
    });
  }
  if (servers.length < batch.servers.length) console.warn(`host ${conn.hostId} sent ${batch.servers.length - servers.length} malformed or surplus stats entries; skipped`);
  if (servers.length === 0) return;
  await MetricsService.recordStats(conn.hostId, { at: typeof batch.at === "string" ? batch.at : new Date().toISOString(), servers });
}
