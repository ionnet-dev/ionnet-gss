import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import { CLOSE_REPLACED, type PanelToAgentRequests } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../../Config.ts";
import { clientIp } from "../../lib/http.ts";
import { HttpError } from "../../lib/HttpError.ts";
import { Host } from "../../models/index.ts";
import { AgentConnection } from "./AgentConnection.ts";
import { pushHostStatus } from "./hostEvents.ts";

/**
 * Every agent connection, by host id. The only way the rest of the panel talks to hosts: controllers call
 * `isOnline()`, `request()` and `disconnect()`; nothing else imports `AgentConnection`.
 * Pushes `host.status` through `LiveGateway` when a host connects, disconnects or goes quiet.
 */
export class AgentGateway {
  private constructor() { }

  private static _connections = new Map<string, AgentConnection>();
  private static _sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * `GET /ws/agent`, mounted at `/ws` by `App.ts`. No auth at upgrade: the first frame (`enrol` or `hello`) is the auth.
   */
  public static readonly router = new Hono().get("/agent", upgradeWebSocket((c) => {
    const conn = new AgentConnection(clientIp(c));
    return {
      onOpen: (_event, ws) => conn.attach(ws),
      onMessage: (event) => {
        conn.handleFrame(String(event.data)).catch((error) => console.error("agent frame failed", error));
      },
      onClose: () => conn.onClosed(),
    };
  }));

  /**
   * Start the offline sweep (every AGENT_HEARTBEAT_SEC: hosts silent for AGENT_OFFLINE_AFTER_SEC are closed and
   * reported offline).
   */
  public static start(): void {
    if (AgentGateway._sweepTimer !== null) return;
    AgentGateway._sweepTimer = setInterval(() => AgentGateway._sweep(), Config.AGENT_HEARTBEAT_SEC * 1000);
  }

  /**
   * Close every socket (1001) and stop the sweep. Called on shutdown.
   */
  public static stop(): void {
    if (AgentGateway._sweepTimer !== null) clearInterval(AgentGateway._sweepTimer);
    AgentGateway._sweepTimer = null;
    for (const conn of AgentGateway._connections.values()) conn.close(1001, "panel shutting down");
    AgentGateway._connections.clear();
  }

  public static isOnline(hostId: string): boolean {
    return AgentGateway._connections.has(hostId);
  }

  /**
   * The live connection of a host. Private: only the gateway may hold an `AgentConnection`.
   */
  private static get(hostId: string): AgentConnection | null {
    return AgentGateway._connections.get(hostId) ?? null;
  }

  public static onlineHostIds(): string[] {
    return [...AgentGateway._connections.keys()];
  }

  /**
   * Send a request to a host's agent.
   * @throws HttpError 409 "<host> is offline." when it isn't connected; `AgentRequestError` from the agent.
   */
  public static async request<T extends keyof PanelToAgentRequests>(
    hostId: string,
    type: T,
    data: PanelToAgentRequests[T]["request"],
    timeoutMs?: number,
  ): Promise<PanelToAgentRequests[T]["response"]> {
    const conn = AgentGateway.get(hostId);
    if (!conn) throw HttpError.conflict("The host is offline. Check that gss-agent is running on it.");
    return await conn.request(type, data, timeoutMs);
  }

  /**
   * Close a host's socket, e.g. with CLOSE_REVOKED when it is disabled or removed.
   */
  public static disconnect(hostId: string, code: number, reason: string): void {
    AgentGateway._connections.get(hostId)?.close(code, reason);
  }

  /**
   * Called by the hello handler after authentication. Replaces an existing connection for the same host
   * (CLOSE_REPLACED) and pushes `host.status` online.
   */
  public static register(conn: AgentConnection): void {
    if (!conn.hostId) throw new Error("AgentGateway.register needs an authenticated connection (hostId unset).");
    const existing = AgentGateway._connections.get(conn.hostId);
    AgentGateway._connections.set(conn.hostId, conn);
    existing?.close(CLOSE_REPLACED, "A newer connection for this host took over.");
    void pushHostStatus(conn.hostId, true, new Date());
  }

  /**
   * Called by `AgentConnection.onClosed()`. Removes the connection only if it is still the registered one, stores
   * `lastSeenAt`, pushes `host.status` offline.
   */
  public static unregister(conn: AgentConnection): void {
    const hostId = conn.hostId;
    if (!hostId || AgentGateway._connections.get(hostId) !== conn) return;
    AgentGateway._connections.delete(hostId);
    const lastSeenAt = new Date(conn.lastFrameAt);
    Host.update({ lastSeenAt }, { where: { id: hostId } })
      .catch((error) => console.error("could not store lastSeenAt", error))
      .finally(() => void pushHostStatus(hostId, false, lastSeenAt));
  }

  private static _sweep(): void {
    const cutoff = Date.now() - Config.AGENT_OFFLINE_AFTER_SEC * 1000;
    for (const conn of [...AgentGateway._connections.values()]) {
      if (conn.lastFrameAt >= cutoff) continue;
      console.warn(`host ${conn.hostId} sent nothing for ${Config.AGENT_OFFLINE_AFTER_SEC} s, marking it offline`);
      conn.close(1001, "No heartbeat received.");
      // The close handshake may never finish on a dead socket, so don't wait for onClose.
      AgentGateway.unregister(conn);
    }
  }
}

export default AgentGateway;
