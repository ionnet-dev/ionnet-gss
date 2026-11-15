/**
 * `AgentGateway.request` for the M4 services (files, transfers, backups) with the agent's error codes turned into
 * HTTP errors. `GameServerService` keeps its own copy (it also handles `port_in_use`).
 */
import type { PanelToAgentRequests } from "@shared/protocol/protocol.gen.ts";
import { AgentGateway } from "../gateways/agent/AgentGateway.ts";
import { HttpError } from "../lib/HttpError.ts";

/**
 * Send a request to a host and map a refusal to an `HttpError`: bad_request 400, forbidden 403, not_found 404,
 * conflict 409, too_large 413, no_space 507, timeout 504, a host that dropped mid-request 503, unsupported 501,
 * anything else 502. The agent's message is kept: it is written for the user.
 * @param timeoutMs Default is AGENT_REQUEST_TIMEOUT_SEC.
 * @throws HttpError 409 when the host is offline, or the mapped refusal.
 */
export async function callAgent<T extends keyof PanelToAgentRequests>(
  hostId: string,
  type: T,
  data: PanelToAgentRequests[T]["request"],
  timeoutMs?: number,
): Promise<PanelToAgentRequests[T]["response"]> {
  try {
    return await AgentGateway.request(hostId, type, data, timeoutMs);
  } catch (error) {
    throw agentErrorToHttp(hostId, error);
  }
}

/**
 * The `HttpError` for a failed agent request (an `HttpError` passes through unchanged).
 */
export function agentErrorToHttp(hostId: string, error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = (error as { code?: string }).code;
  const message = (error as Error).message;
  switch (code) {
    case "bad_request": return HttpError.badRequest(message);
    case "forbidden": return HttpError.forbidden(message);
    case "not_found": return HttpError.notFound(message);
    case "conflict": return HttpError.conflict(message);
    case "too_large": return new HttpError(413, message);
    case "no_space": return new HttpError(507, message);
    case "timeout": return new HttpError(504, "The host didn't answer in time. Try again in a moment.");
    case "unsupported":
      if (!AgentGateway.isOnline(hostId)) return new HttpError(503, `The host disconnected before it answered (${message}). Try again once it is back.`);
      return new HttpError(501, `The host's agent can't do that yet: ${message} Update gss-agent on the host.`);
    default: return new HttpError(502, `The host refused: ${message}`);
  }
}
