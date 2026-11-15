import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { WSContext } from "hono/ws";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { LIVE_AUTH_TIMEOUT_SEC } from "@shared/live.ts";
import type { LiveClientFrame, LiveEventName, LiveEvents, LiveServerFrame, LiveTopic } from "@shared/live.ts";
import type { Permission } from "@shared/permissions.ts";
import { Config } from "../../Config.ts";
import { User } from "../../models/index.ts";

const WS_OPEN = 1;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * `/ws/live`: pushes `LiveEvents` to browsers. Controllers and the agent gateway call `push()`; nothing else imports
 * the sockets. Auth is the first frame (`{ t: "auth", token }`, LIVE_AUTH_TIMEOUT_SEC) checked with
 * `User.findByToken()`; the origin must be PUBLIC_URL or the panel's own host (cross-site WebSocket hijacking).
 */
export class LiveGateway {
  private constructor() { }

  private static _clients = new Set<LiveGateway.Client>();
  private static _sweeper: ReturnType<typeof setInterval> | null = null;

  /**
   * `GET /ws/live`, mounted at `/ws` by `App.ts`.
   */
  public static readonly router = new Hono().get("/live", async (c, next) => {
    // Browsers always send Origin on a WebSocket handshake; other clients (scripts, tools) don't and can't be hijacked.
    const origin = c.req.header("origin");
    if (origin && !LiveGateway.isAllowedOrigin(origin, c.req.header("host"))) {
      return c.json({ message: "This origin may not open the live socket." }, 403);
    }
    return await next();
  }, upgradeWebSocket((_c) => {
    let client: LiveGateway.Client | null = null;
    let authenticating = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    return {
      onOpen: (_event, ws) => {
        timer = setTimeout(() => {
          LiveGateway.send(ws, { t: "error", message: "No auth frame arrived in time." });
          ws.close(LIVE_CLOSE.UNAUTHORIZED, "Authentication timed out.");
        }, LIVE_AUTH_TIMEOUT_SEC * 1000);
      },
      onMessage: async (event, ws) => {
        let frame: LiveClientFrame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          LiveGateway.send(ws, { t: "error", message: "Frames must be JSON." });
          return;
        }

        if (!client) {
          if (frame?.t !== "auth" || typeof frame.token !== "string") {
            LiveGateway.send(ws, { t: "error", message: "Send an auth frame first." });
            ws.close(LIVE_CLOSE.UNAUTHORIZED, "Authentication required.");
            return;
          }
          if (authenticating) return;
          authenticating = true;
          let user: User | null = null;
          try {
            user = await User.findByToken(frame.token);
          } catch (error) {
            console.error("live auth failed", error);
          }
          if (!user) {
            LiveGateway.send(ws, { t: "error", message: "The token is invalid or expired." });
            ws.close(LIVE_CLOSE.UNAUTHORIZED, "Invalid token.");
            return;
          }
          if (ws.readyState !== WS_OPEN) return;
          clearTimer();
          client = {
            ws,
            userId: user.id,
            tokenVersion: user.tokenVersion,
            permissions: user.getPermissions(),
            isAdmin: user.isAdmin(),
            topics: new Set(),
          };
          LiveGateway._clients.add(client);
          LiveGateway.send(ws, { t: "ready", userId: user.id });
          return;
        }

        switch (frame?.t) {
          case "subscribe":
            // Stream topics (`server:<id>`) arrive with M2, which also checks access per topic. Until then nothing may subscribe.
            LiveGateway.send(ws, { t: "error", message: "There are no streams to subscribe to yet." });
            break;
          case "unsubscribe":
            if (typeof frame.topic === "string") client.topics.delete(frame.topic);
            break;
          default:
            LiveGateway.send(ws, { t: "error", message: "Unknown frame." });
        }
      },
      onClose: () => {
        clearTimer();
        if (client) LiveGateway._clients.delete(client);
      },
      onError: () => {
        clearTimer();
        if (client) LiveGateway._clients.delete(client);
      },
    };
  }));

  /**
   * Start the sweeper that drops sockets that closed without a close event.
   */
  public static start(): void {
    LiveGateway._sweeper ??= setInterval(() => {
      for (const client of LiveGateway._clients) {
        if (client.ws.readyState !== WS_OPEN) LiveGateway._clients.delete(client);
      }
    }, SWEEP_INTERVAL_MS);
  }

  public static stop(): void {
    if (LiveGateway._sweeper !== null) clearInterval(LiveGateway._sweeper);
    LiveGateway._sweeper = null;
    for (const client of LiveGateway._clients) {
      try {
        client.ws.close(1001, "panel shutting down");
      } catch {
        // Already closed.
      }
    }
    LiveGateway._clients.clear();
  }

  /**
   * Send an event to every authenticated socket in `audience`. Never throws; safe to call from any handler.
   */
  public static push<E extends LiveEventName>(event: E, data: LiveEvents[E], audience: LiveGateway.Audience): void {
    const frame = { t: "event", event, data } as LiveServerFrame;
    for (const client of LiveGateway._clients) {
      if (LiveGateway.isInAudience(client, audience)) LiveGateway.send(client.ws, frame);
    }
  }

  /**
   * Close a user's sockets, e.g. with LIVE_CLOSE.UNAUTHORIZED after a password change or LIVE_CLOSE.RECONNECT after a
   * role change.
   */
  public static closeUser(userId: number, code: number, reason: string): void {
    for (const client of LiveGateway._clients) {
      if (client.userId !== userId) continue;
      LiveGateway._clients.delete(client);
      try {
        client.ws.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  private static isInAudience(client: LiveGateway.Client, audience: LiveGateway.Audience): boolean {
    if ("all" in audience) return true;
    if ("topic" in audience) return client.topics.has(audience.topic);
    if (audience.userIds?.includes(client.userId)) return true;
    return "permission" in audience && (client.isAdmin || client.permissions.has(audience.permission));
  }

  private static isAllowedOrigin(origin: string, host: string | undefined): boolean {
    try {
      const url = new URL(origin);
      return url.origin === new URL(Config.PUBLIC_URL).origin || (host !== undefined && url.host === host);
    } catch {
      return false;
    }
  }

  private static send(ws: WSContext, frame: LiveServerFrame): void {
    try {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(frame));
    } catch {
      // The socket closed under us; the sweeper or onClose drops it.
    }
  }
}

export namespace LiveGateway {
  /**
   * Who receives an event. `permission` reaches users holding the key (admins always), plus any `userIds`.
   */
  export type Audience =
    | { all: true }
    | { userIds: number[] }
    | { permission: Permission; userIds?: number[] }
    | { topic: LiveTopic };

  export interface Client {
    ws: WSContext;
    userId: number;
    tokenVersion: number;
    permissions: Set<Permission>;
    isAdmin: boolean;
    topics: Set<LiveTopic>;
  }
}

export default LiveGateway;
