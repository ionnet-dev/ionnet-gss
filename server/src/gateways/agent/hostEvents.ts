/**
 * Live events about hosts, sent from the agent gateway. Audience: HOSTS_MANAGE plus the users granted the host.
 * Both functions never throw (a failed lookup must not break an agent connection).
 */
import { HostGrant } from "../../models/index.ts";
import { LiveGateway } from "../live/LiveGateway.ts";

async function hostAudience(hostId: string): Promise<LiveGateway.Audience> {
  const grants = await HostGrant.findAll({ where: { hostId }, attributes: ["userId"] });
  return { permission: "HOSTS_MANAGE", userIds: grants.map((grant) => grant.userId) };
}

/**
 * The host's row or facts changed.
 */
export async function pushHostUpdated(hostId: string): Promise<void> {
  try {
    LiveGateway.push("host.updated", { hostId }, await hostAudience(hostId));
  } catch (error) {
    console.error("host.updated push failed", error);
  }
}

/**
 * New usage figures (load, available memory, free disk) for the host detail page. Throttled by the heartbeat handler.
 */
export async function pushHostFacts(hostId: string): Promise<void> {
  try {
    LiveGateway.push("host.facts", { hostId }, await hostAudience(hostId));
  } catch (error) {
    console.error("host.facts push failed", error);
  }
}

/**
 * The host's agent connected or went away.
 */
export async function pushHostStatus(hostId: string, online: boolean, lastSeenAt: Date | null): Promise<void> {
  try {
    LiveGateway.push("host.status", { hostId, online, lastSeenAt: lastSeenAt?.toISOString() ?? null }, await hostAudience(hostId));
  } catch (error) {
    console.error("host.status push failed", error);
  }
}
