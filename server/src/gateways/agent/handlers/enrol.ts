import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION, type EnrolRequest, type EnrolResponse, PROTOCOL_VERSION } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../../../lib/HttpError.ts";
import { AuditLog, Host } from "../../../models/index.ts";
import { LiveGateway } from "../../live/LiveGateway.ts";
import { AgentCloseError, type AgentConnection, AgentRequestError } from "../AgentConnection.ts";
import { pushHostUpdated } from "../hostEvents.ts";
import { requireFacts, requireObject } from "./guards.ts";

/**
 * `enrol`: check `protocolVersion` (else CLOSE_UNSUPPORTED_VERSION), redeem the token with `Host.enrol()`, audit
 * `host.enrolled`, push `host.updated` + `enrolToken.updated`. The connection closes with CLOSE_ENROLLED after the
 * response is sent. A bad token answers `unauthorized` and closes with CLOSE_UNAUTHORIZED.
 */
export async function handleEnrol(conn: AgentConnection, data: EnrolRequest): Promise<EnrolResponse> {
  const request = requireObject<Partial<EnrolRequest>>(data, "enrol");
  if (typeof request.token !== "string" || !request.token) throw new AgentRequestError("bad_request", "enrol needs a token.");
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new AgentCloseError(
      "unsupported",
      `This panel speaks agent protocol ${PROTOCOL_VERSION}, the agent speaks ${request.protocolVersion}. Update gss-agent.`,
      CLOSE_UNSUPPORTED_VERSION,
    );
  }
  const facts = requireFacts(request.facts);

  let enrolled;
  try {
    enrolled = await Host.enrol(request.token, facts, request.protocolVersion);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) throw new AgentCloseError("unauthorized", error.message, CLOSE_UNAUTHORIZED);
    throw error;
  }
  const { host, credential } = enrolled;

  await AuditLog.record({
    action: "host.enrolled",
    hostId: host.id,
    details: { name: host.name, hostname: facts.hostname, agentVersion: facts.agentVersion },
    ip: conn.remoteAddress,
  });
  void pushHostUpdated(host.id);
  LiveGateway.push("enrolToken.updated", { enrolTokenId: null }, { permission: "HOSTS_MANAGE" });
  return { hostId: host.id, hostName: host.name, credential };
}
