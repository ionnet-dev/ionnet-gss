import type { AgentUpdateStatus } from "@shared/protocol/protocol.gen.ts";
import { AgentUpdater } from "../../../hosts/AgentUpdater.ts";
import type { AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const STATES: readonly string[] = ["current", "downloading", "waiting", "restarting", "failed"];
const MAX_MESSAGE_CHARS = 2000;
const MAX_WAITING_FOR = 50;
const MAX_WAITING_ITEM_CHARS = 200;

/**
 * `agent.updateStatus`: the progress of the update `agent.update` started. Bad frames from a ready connection are
 * ignored (an event has no one to answer).
 */
export async function handleAgentUpdateStatus(conn: AgentConnection, data: AgentUpdateStatus): Promise<void> {
  if (!conn.hostId) return;
  const raw = requireObject<Partial<AgentUpdateStatus>>(data, "agent.updateStatus");
  if (!STATES.includes(raw.state as string) || typeof raw.sha256 !== "string") return;
  AgentUpdater.onStatus(conn.hostId, {
    state: raw.state!,
    sha256: raw.sha256.slice(0, 64),
    message: typeof raw.message === "string" ? raw.message.slice(0, MAX_MESSAGE_CHARS) : "",
    waitingFor: Array.isArray(raw.waitingFor)
      ? raw.waitingFor.filter((item): item is string => typeof item === "string").slice(0, MAX_WAITING_FOR).map((item) => item.slice(0, MAX_WAITING_ITEM_CHARS))
      : [],
  });
}
