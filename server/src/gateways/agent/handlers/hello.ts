import {
  CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  type HelloRequest,
  type HelloResponse,
  PROTOCOL_VERSION,
} from "@shared/protocol/protocol.gen.ts";
import { AppSystem } from "../../../AppSystem.ts";
import { Config } from "../../../Config.ts";
import { Host } from "../../../models/index.ts";
import { AgentCloseError, type AgentConnection, AgentRequestError } from "../AgentConnection.ts";
import { AgentGateway } from "../AgentGateway.ts";
import { pushHostUpdated } from "../hostEvents.ts";
import { requireFacts, requireObject } from "./guards.ts";

/**
 * `hello`: check `protocolVersion`, `Host.authenticateAgent()` (unknown → `unauthorized` + CLOSE_UNAUTHORIZED, the
 * agent stops; disabled → `forbidden` + CLOSE_REVOKED, the agent retries slowly), store facts + versions, set `conn.hostId` and `phase = "ready"`, `AgentGateway.register(conn)`.
 * Answers `{ hostName, heartbeatSec: AGENT_HEARTBEAT_SEC, panelVersion }`. M2: reconcile `data.servers` with the
 * GameServer rows (state, specHash drift).
 */
export async function handleHello(conn: AgentConnection, data: HelloRequest): Promise<HelloResponse> {
  const request = requireObject<Partial<HelloRequest>>(data, "hello");
  if (typeof request.hostId !== "string" || typeof request.credential !== "string") {
    throw new AgentRequestError("bad_request", "hello needs a hostId and a credential.");
  }
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new AgentCloseError(
      "unsupported",
      `This panel speaks agent protocol ${PROTOCOL_VERSION}, the agent speaks ${request.protocolVersion}. Update gss-agent.`,
      CLOSE_UNSUPPORTED_VERSION,
    );
  }
  const facts = requireFacts(request.facts);

  const host = await Host.authenticateAgent(request.hostId, request.credential);
  if (!host) {
    throw new AgentCloseError(
      "unauthorized",
      "This panel does not know the host id and credential (the host was removed, or the config is from another panel). Create an enrol token on the Hosts page and run `gss-agent enrol --force`.",
      CLOSE_UNAUTHORIZED,
    );
  }
  if (host.disabled) {
    throw new AgentCloseError(
      "forbidden",
      `The host "${host.name}" is disabled in the panel. Enable it on its page in the panel; the agent keeps retrying and reconnects on its own.`,
      CLOSE_REVOKED,
    );
  }

  host.protocolVersion = request.protocolVersion;
  const factsChanged = await host.recordFacts(facts);

  conn.markReady(host.id);
  conn.lastFactsPushAt = Date.now();
  AgentGateway.register(conn); // Pushes `host.status`; `host.updated` only when the shown facts changed.
  if (factsChanged) void pushHostUpdated(host.id);
  return { hostName: host.name, heartbeatSec: Config.AGENT_HEARTBEAT_SEC, panelVersion: AppSystem.version };
}
