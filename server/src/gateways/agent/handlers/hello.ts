import {
  CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  type HelloRequest,
  type HelloResponse,
  type InstallProgress,
  PROTOCOL_VERSION,
  SERVER_STATE_VALUES,
  type ServerStatus,
} from "@shared/protocol/protocol.gen.ts";
import { AppSystem } from "../../../AppSystem.ts";
import { Config } from "../../../Config.ts";
import { Host } from "../../../models/index.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import { AgentCloseError, type AgentConnection, AgentRequestError } from "../AgentConnection.ts";
import { AgentGateway } from "../AgentGateway.ts";
import { pushHostUpdated } from "../hostEvents.ts";
import { requireFacts, requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SERVERS = 1000;
/**
 * The agent only reads panel requests once it has the hello answer, so reconcile starts a moment after it.
 */
const RECONCILE_DELAY_MS = 250;

/**
 * The agent's inventory, shape-checked (an absent list from an M1 agent is empty).
 * @throws AgentRequestError `bad_request` naming the first bad entry.
 */
function parseServers(value: unknown): ServerStatus[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AgentRequestError("bad_request", "hello servers must be a list.");
  if (value.length > MAX_SERVERS) throw new AgentRequestError("bad_request", `hello can report at most ${MAX_SERVERS} servers.`);
  return value.map((raw, i): ServerStatus => {
    const status = requireObject<Partial<ServerStatus>>(raw, `hello servers[${i}]`);
    const bad = (what: string) => new AgentRequestError("bad_request", `hello servers[${i}]: ${what}`);
    if (typeof status.serverId !== "string" || !UUID_PATTERN.test(status.serverId)) throw bad("serverId must be a UUID.");
    if (!SERVER_STATE_VALUES.includes(status.state as never)) throw bad(`unknown state "${String(status.state)}".`);
    if (typeof status.since !== "string") throw bad("since must be a timestamp.");
    if (status.exitCode !== null && status.exitCode !== undefined && !Number.isSafeInteger(status.exitCode)) throw bad("exitCode must be a whole number or null.");
    if (typeof status.specHash !== "string") throw bad("specHash must be a string.");
    if (status.reason !== null && status.reason !== undefined && typeof status.reason !== "string") throw bad("reason must be a string or null.");
    let progress: InstallProgress | null = null;
    if (status.installProgress) {
      const raw = requireObject<Partial<InstallProgress>>(status.installProgress, "installProgress");
      if (!Number.isSafeInteger(raw.step) || !Number.isSafeInteger(raw.total) || typeof raw.name !== "string") throw bad("installProgress needs a step, a total and a name.");
      progress = { step: raw.step!, total: raw.total!, name: raw.name.slice(0, 64) };
    }
    return {
      serverId: status.serverId.toLowerCase(),
      state: status.state!,
      since: status.since,
      exitCode: status.exitCode ?? null,
      specHash: status.specHash,
      installProgress: progress,
      reason: status.reason?.slice(0, 2000) ?? null,
      services: [], // TODO(builder): C (M3) — validate and keep status.services (≤ 4, name/image/state checked).
    };
  });
}

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
  const servers = parseServers(request.servers);

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
  setTimeout(() => {
    GameServerService.reconcile(host.id, servers).catch((error) => console.error(`reconcile after hello of host ${host.id} failed`, error));
  }, RECONCILE_DELAY_MS);
  return { hostName: host.name, heartbeatSec: Config.AGENT_HEARTBEAT_SEC, panelVersion: AppSystem.version };
}
