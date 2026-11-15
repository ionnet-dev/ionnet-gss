import {
  type InstallProgress,
  SERVER_STATE_VALUES,
  type StateChange,
} from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import { MetricsService } from "../../../servers/MetricsService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_CHARS = 2000;

/**
 * `server.state`: shape-check (requireObject, serverId UUID, state in SERVER_STATE_VALUES), then
 * `GameServerService.applyStateChange(conn.hostId, data)`, then `MetricsService.onStateChange` (M4: players reset).
 */
export async function handleServerState(conn: AgentConnection, data: StateChange): Promise<void> {
  if (!conn.hostId) return;
  const event = requireObject<Partial<StateChange>>(data, "server.state");
  if (typeof event.serverId !== "string" || !UUID_PATTERN.test(event.serverId)) throw new AgentRequestError("bad_request", "server.state needs a serverId (UUID).");
  if (!SERVER_STATE_VALUES.includes(event.state as never)) throw new AgentRequestError("bad_request", `server.state has an unknown state "${String(event.state)}".`);
  if (!SERVER_STATE_VALUES.includes(event.previous as never)) throw new AgentRequestError("bad_request", `server.state has an unknown previous state "${String(event.previous)}".`);
  if (event.exitCode !== null && event.exitCode !== undefined && !Number.isSafeInteger(event.exitCode)) throw new AgentRequestError("bad_request", "server.state exitCode must be a whole number or null.");
  if (event.reason !== null && event.reason !== undefined && typeof event.reason !== "string") throw new AgentRequestError("bad_request", "server.state reason must be a string or null.");

  let progress: InstallProgress | null = null;
  if (event.installProgress !== null && event.installProgress !== undefined) {
    const raw = requireObject<Partial<InstallProgress>>(event.installProgress, "server.state installProgress");
    if (!Number.isSafeInteger(raw.step) || !Number.isSafeInteger(raw.total) || typeof raw.name !== "string") {
      throw new AgentRequestError("bad_request", "server.state installProgress needs a step, a total and a name.");
    }
    progress = { step: raw.step!, total: raw.total!, name: raw.name.slice(0, 64) };
  }

  await GameServerService.applyStateChange(conn.hostId, {
    serverId: event.serverId.toLowerCase(),
    state: event.state!,
    previous: event.previous!,
    at: typeof event.at === "string" ? event.at : new Date().toISOString(),
    exitCode: event.exitCode ?? null,
    reason: event.reason?.slice(0, MAX_REASON_CHARS) ?? null,
    installProgress: progress,
  });
  MetricsService.onStateChange(event.serverId.toLowerCase(), event.state!);
}
