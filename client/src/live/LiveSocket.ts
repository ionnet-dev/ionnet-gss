/**
 * The browser's `/ws/live` connection: one per tab, opened after sign-in. Sends `auth` first, reconnects with
 * backoff, re-sends topic subscriptions after a reconnect, and hands events to `on()` listeners. No polling anywhere
 * else: data hooks refetch when an event names their data (`useResource`'s `liveEvents`).
 */
import { LIVE_CLOSE } from "@shared/constants.ts";
import type { LiveEventName, LiveClientFrame, LiveEvents, LiveServerFrame, LiveTopic } from "@shared/live.ts";
import { BaseApi } from "@/Api/BaseApi.ts";
import { Controller } from "@/controllers/Controller.ts";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// Pause before reconnecting after LIVE_CLOSE.RECONNECT.
const RECONNECT_DELAY_MS = 500;

export type LiveStatus = "idle" | "connecting" | "open" | "closed";

type Listener<E extends LiveEventName> = (data: LiveEvents[E]) => void;

export class LiveSocket extends Controller {
  public status: LiveStatus = "idle";

  private _eventListeners = new Map<LiveEventName, Set<Listener<LiveEventName>>>();
  private _topics = new Set<LiveTopic>();
  private _reconnectListeners = new Set<() => void>();
  private _socket: WebSocket | null = null;
  private _token: string | null = null;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _attempt = 0;
  private _hasOpened = false;

  /**
   * Open the socket with this bearer token (same-origin `/ws/live`). Calling it again replaces the connection.
   */
  public connect(token: string): void {
    this._teardown();
    this._token = token;
    this._hasOpened = false;
    this._attempt = 0;
    this._open();
  }

  /**
   * Close for good (sign-out).
   */
  public disconnect(): void {
    this._teardown();
    this._token = null;
    this.status = "idle";
    this.notify();
  }

  /**
   * Run `listener` each time the socket is back after a drop, so data hooks can refetch what they missed. Returns the
   * unsubscribe function.
   */
  public onReconnect(listener: () => void): () => void {
    this._reconnectListeners.add(listener);
    return () => this._reconnectListeners.delete(listener);
  }

  /**
   * Listen for one event type. Returns the unsubscribe function.
   */
  public on<E extends LiveEventName>(event: E, listener: Listener<E>): () => void {
    let set = this._eventListeners.get(event);
    if (!set) {
      set = new Set();
      this._eventListeners.set(event, set);
    }
    set.add(listener as Listener<LiveEventName>);
    return () => set.delete(listener as Listener<LiveEventName>);
  }

  /**
   * Deliver an event to its listeners. Called by the socket's message handler.
   */
  public emit<E extends LiveEventName>(event: E, data: LiveEvents[E]): void {
    for (const listener of this._eventListeners.get(event) ?? []) listener(data);
  }

  /**
   * Start receiving a stream topic (M2: `server:<id>` console and stats).
   */
  public subscribeTopic(topic: LiveTopic): () => void {
    this._topics.add(topic);
    this._send({ t: "subscribe", topic });
    return () => {
      this._topics.delete(topic);
      this._send({ t: "unsubscribe", topic });
    };
  }

  //#region Connection
  private _open(): void {
    if (!this._token) return;
    const token = this._token;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/live`);
    this._socket = socket;
    this.status = "connecting";
    this.notify();

    socket.onopen = () => socket.send(JSON.stringify({ t: "auth", token }));
    socket.onmessage = (message) => {
      if (this._socket !== socket) return;
      this._handleFrame(message.data);
    };
    socket.onclose = (event) => {
      if (this._socket !== socket) return;
      this._socket = null;
      this._handleClose(event.code, token);
    };
  }

  private _handleFrame(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: LiveServerFrame;
    try {
      frame = JSON.parse(raw) as LiveServerFrame;
    } catch {
      return;
    }
    if (frame.t === "ready") {
      const reconnected = this._hasOpened;
      this._hasOpened = true;
      this._attempt = 0;
      this.status = "open";
      this.notify();
      for (const topic of this._topics) this._send({ t: "subscribe", topic });
      if (reconnected) for (const listener of this._reconnectListeners) listener();
    }
    else if (frame.t === "event") {
      this.emit(frame.event, frame.data as never);
    }
  }

  private _handleClose(code: number, sentToken: string | null): void {
    // The socket authenticated with a token that was replaced meanwhile (own role or password change): retry with
    // the stored one instead of signing out.
    const stored = BaseApi.getToken();
    if (code === LIVE_CLOSE.UNAUTHORIZED && stored !== null && stored !== sentToken) {
      this._token = stored;
      this._open();
      return;
    }
    if (code === LIVE_CLOSE.UNAUTHORIZED) {
      this._token = null;
      this.status = "closed";
      this.notify();
      window.dispatchEvent(new Event(BaseApi.UNAUTHORIZED_EVENT));
      return;
    }
    if (code === LIVE_CLOSE.RECONNECT) {
      // Give the HTTP response that carries the fresh token a moment to be stored, then use whatever is stored.
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._token = BaseApi.getToken() ?? this._token;
        this._open();
      }, RECONNECT_DELAY_MS);
      return;
    }
    this.status = "closed";
    this.notify();
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this._attempt, BACKOFF_MAX_MS);
    this._attempt++;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._open();
    }, delay);
  }

  private _send(frame: LiveClientFrame): void {
    if (this.status === "open") this._socket?.send(JSON.stringify(frame));
  }

  private _teardown(): void {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    const socket = this._socket;
    this._socket = null;
    socket?.close();
  }
  //#endregion
}

/**
 * The app's one live socket.
 */
export const liveSocket = new LiveSocket();

export default liveSocket;
