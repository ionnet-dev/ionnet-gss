import { CLOSE_REVOKED, type Heartbeat } from "@shared/protocol/protocol.gen.ts";
import { Host } from "../../../models/index.ts";
import type { AgentConnection } from "../AgentConnection.ts";
import { pushHostFacts, pushHostUpdated } from "../hostEvents.ts";
import { requireFacts, requireObject } from "./guards.ts";

/**
 * Shortest time between two usage pushes (`host.facts`) for one host.
 */
export const FACTS_PUSH_INTERVAL_MS = 60_000;

/**
 * `heartbeat`: `Host.recordFacts()`. Pushes `host.updated` only when the facts the list shows changed (versions, OS,
 * totals), otherwise `host.facts` (live load/RAM/disk for the detail page) at most once per FACTS_PUSH_INTERVAL_MS.
 * Online/offline is `host.status`, pushed by `AgentGateway`. A host removed or disabled since its hello is closed
 * with CLOSE_REVOKED.
 */
export async function handleHeartbeat(conn: AgentConnection, data: Heartbeat): Promise<void> {
  if (!conn.hostId) return;
  const heartbeat = requireObject<Partial<Heartbeat>>(data, "heartbeat");
  const facts = requireFacts(heartbeat.facts);

  const host = await Host.findByPk(conn.hostId);
  if (!host || host.disabled) {
    conn.close(CLOSE_REVOKED, "The host was removed or disabled in the panel.");
    return;
  }
  const changed = await host.recordFacts(facts);
  const now = Date.now();
  if (changed) {
    conn.lastFactsPushAt = now;
    void pushHostUpdated(host.id);
  }
  else if (now - conn.lastFactsPushAt >= FACTS_PUSH_INTERVAL_MS) {
    conn.lastFactsPushAt = now;
    void pushHostFacts(host.id);
  }
}
