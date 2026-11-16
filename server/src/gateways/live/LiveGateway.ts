import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { WSContext } from "hono/ws";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { LIVE_AUTH_TIMEOUT_SEC } from "@shared/live.ts";
import type { LiveClientFrame, LiveEventName, LiveEvents, LiveServerFrame, LiveTopic } from "@shared/live.ts";
import type { Permission } from "@shared/permissions.ts";
import { Config } from "../../Config.ts";
import { User } from "../../models/index.ts";
import { GameServerService } from "../../servers/GameServerService.ts";
import { ServerAccess } from "../../servers/ServerAccess.ts";

const WS_OPEN = 1;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_TOPICS = 20;
/**
 * A socket whose unsent data passes this is closed with LIVE_CLOSE.TOO_SLOW instead of buffering without bound.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_SOCKETS_PER_USER = 16;
/**
 * Frames a socket may have waiting to be handled (they are handled one at a time); more closes it.
 */
const MAX_PENDING_FRAMES = 32;

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Frames are handled one at a time, in order, so checks like MAX_TOPICS can't be raced by parallel subscribes.
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;

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
      onMessage: (event, ws) => {
        if (++pending > MAX_PENDING_FRAMES) {
          ws.close(LIVE_CLOSE.TOO_SLOW, "Too many frames at once.");
          return;
        }
        queue = queue.then(() => handleFrame(event.data, ws)).catch((error) => console.error("live frame failed", error)).finally(() => {
          pending--;
        });
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

    async function handleFrame(data: unknown, ws: WSContext): Promise<void> {
      if (ws.readyState !== WS_OPEN) return;
      let frame: LiveClientFrame;
      try {
        frame = JSON.parse(String(data));
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
        let open = 0;
        for (const other of LiveGateway._clients) if (other.userId === user.id) open++;
        if (open >= MAX_SOCKETS_PER_USER) {
          LiveGateway.send(ws, { t: "error", message: `You have ${open} live connections open (at most ${MAX_SOCKETS_PER_USER}). Close some tabs.` });
          ws.close(LIVE_CLOSE.TOO_MANY, "Too many live connections.");
          return;
        }
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
        case "subscribe": {
          const match = typeof frame.topic === "string" ? /^server:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(frame.topic) : null;
          if (!match) {
            LiveGateway.send(ws, { t: "error", message: "Unknown topic. Streams are named server:<id>.", topic: typeof frame.topic === "string" ? frame.topic : undefined });
            break;
          }
          const topic: LiveTopic = `server:${match[1].toLowerCase()}`;
          if (!client.topics.has(topic) && client.topics.size >= MAX_TOPICS) {
            LiveGateway.send(ws, { t: "error", message: `You can follow at most ${MAX_TOPICS} streams at once.`, topic });
            break;
          }
          const checkedAt = ServerAccess.clock();
          const serverId = match[1].toLowerCase();
          // No await between the revocation check and `topics.add`: a share removed (or a server deleted) while the
          // database check ran has already called `dropTopic`, which found nothing to drop.
          if (!await GameServerService.canAccess(client.userId, serverId) || ServerAccess.revokedSince(serverId, client.userId, checkedAt)) {
            LiveGateway.send(ws, { t: "error", message: "There is no game server with that id that you may follow.", topic });
            break;
          }
          client.topics.add(topic);
          LiveGateway.send(ws, { t: "subscribed", topic });
          break;
        }
        case "unsubscribe":
          if (typeof frame.topic === "string") client.topics.delete(frame.topic.toLowerCase() as LiveTopic);
          break;
        default:
          LiveGateway.send(ws, { t: "error", message: "Unknown frame." });
      }
    }
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
    let text: string | null = null;
    for (const client of LiveGateway._clients) {
      if (!LiveGateway.isInAudience(client, audience)) continue;
      text ??= JSON.stringify({ t: "event", event, data } as LiveServerFrame);
      LiveGateway.sendText(client, text);
    }
  }

  /**
   * Unsubscribe a user's sockets from a topic (M5: a removed share), telling each with `{ t: "error", topic }` so the
   * client stops expecting the stream.
   */
  public static dropTopic(userId: number, topic: LiveTopic): void {
    for (const client of LiveGateway._clients) {
      if (client.userId !== userId || !client.topics.delete(topic)) continue;
      LiveGateway.send(client.ws, { t: "error", message: "You no longer have access to this server.", topic });
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

  /**
   * Send to an authenticated client, closing it with LIVE_CLOSE.TOO_SLOW when its send buffer is past
   * MAX_BUFFERED_BYTES (a slow network or a stalled tab): it reconnects and refetches instead of growing memory.
   */
  private static sendText(client: LiveGateway.Client, text: string): void {
    const ws = client.ws;
    try {
      if (ws.readyState !== WS_OPEN) return;
      const buffered = (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0;
      if (buffered + text.length > MAX_BUFFERED_BYTES) {
        LiveGateway._clients.delete(client);
        ws.close(LIVE_CLOSE.TOO_SLOW, "The connection fell behind; reconnect.");
        return;
      }
      ws.send(text);
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
