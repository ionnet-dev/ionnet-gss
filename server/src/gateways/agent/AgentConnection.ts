import type { WSContext } from "hono/ws";
import {
  CLOSE_ENROLLED,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_ERROR,
  type Envelope,
  type ErrorCode,
  HELLO_TIMEOUT_SEC,
  type PanelToAgentEvents,
  type PanelToAgentRequests,
} from "@shared/protocol/protocol.gen.ts";
import { Config } from "../../Config.ts";
import { HttpError } from "../../lib/HttpError.ts";
import { AgentGateway } from "./AgentGateway.ts";
import { EVENT_HANDLERS, REQUEST_HANDLERS } from "./handlers/index.ts";

/**
 * Largest text frame accepted from an agent (matches the agent's own `MaxFrameBytes`).
 */
const MAX_FRAME_CHARS = 4 * 1024 * 1024;
/**
 * WebSocket close reasons are limited to 123 bytes; a longer one makes `close()` throw and the socket stays open.
 */
const MAX_CLOSE_REASON_BYTES = 123;
/**
 * WebSocket close code for "the server failed" (RFC 6455), used when the first request fails unexpectedly.
 */
const CLOSE_INTERNAL_ERROR = 1011;

type AnyRequestHandler = (conn: AgentConnection, data: unknown) => Promise<unknown>;
type AnyEventHandler = (conn: AgentConnection, data: unknown) => Promise<void>;

/**
 * One agent WebSocket. Owns the envelope rules: request ids, pending responses with timeouts, and the phase machine
 *   new ──enrol──► (answer, close CLOSE_ENROLLED)
 *   new ──hello──► ready ──(requests, events both ways)──► closed
 * Anything but `enrol`/`hello` before `ready`, or either of them after, closes with CLOSE_PROTOCOL_ERROR. A failed
 * first request is answered and then always closes the socket (its own close code, CLOSE_PROTOCOL_ERROR for a bad
 * request, 1011 otherwise). Until `markReady()` or a successful enrol, the hello timer runs: no success within
 * HELLO_TIMEOUT_SEC closes with CLOSE_HELLO_TIMEOUT. Incoming requests and events are dispatched to `handlers/` by
 * type; a handler's thrown `AgentRequestError`/`HttpError` becomes an `ok: false` response.
 */
export class AgentConnection {
  /**
   * Set by the hello handler once the host is authenticated.
   */
  public hostId: string | null = null;
  public phase: AgentConnection.Phase = "new";
  /**
   * Unix ms of the last frame from the agent; the gateway's sweep marks quiet hosts offline.
   */
  public lastFrameAt = Date.now();
  /**
   * Unix ms of the last `host.updated`/`host.facts` push for this host, so heartbeats push usage at most once per
   * `FACTS_PUSH_INTERVAL_MS` (see `handlers/heartbeat.ts`).
   */
  public lastFactsPushAt = 0;

  private _ws: WSContext | null = null;
  private _nextId = 1;
  private _pending = new Map<string, AgentConnection.Pending>();
  private _helloTimer: ReturnType<typeof setTimeout> | null = null;
  private _queue: Promise<void> = Promise.resolve();

  constructor(
    /** Remote IP, for logs and the audit log. */
    public readonly remoteAddress: string | null,
  ) {}

  /**
   * Called on socket open. Starts the hello timer.
   */
  public attach(ws: WSContext): void {
    this._ws = ws;
    this._helloTimer = setTimeout(() => {
      this._helloTimer = null;
      if (this.phase === "new") this.close(CLOSE_HELLO_TIMEOUT, `No successful enrol or hello within ${HELLO_TIMEOUT_SEC} seconds.`);
    }, HELLO_TIMEOUT_SEC * 1000);
  }

  /**
   * Mark the connection authenticated: called by the hello handler once the host is known. Stops the hello timer.
   * @throws AgentRequestError when the socket already closed (e.g. the hello timer fired while the hello was handled),
   * so a dead connection is never registered.
   */
  public markReady(hostId: string): void {
    if (this.phase !== "new") throw new AgentRequestError("internal", "The connection closed before the hello finished.");
    this.hostId = hostId;
    this.phase = "ready";
    this._clearHelloTimer();
  }

  /**
   * Parse one text frame and route it: responses resolve `_pending`, requests and events go to the handler registry.
   * Requests and events are processed one at a time, in arrival order (a heartbeat never overtakes the hello).
   */
  public async handleFrame(text: string): Promise<void> {
    this.lastFrameAt = Date.now();
    if (this.phase === "closed") return;
    if (text.length > MAX_FRAME_CHARS) return this._protocolError("Frame is too large.");

    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      return this._protocolError("Frame is not valid JSON.");
    }
    if (typeof envelope !== "object" || envelope === null || !["request", "response", "event"].includes(envelope.kind)) {
      return this._protocolError("Frame is not an envelope.");
    }

    if (envelope.kind === "response") {
      this._handleResponse(envelope);
      return;
    }
    this._queue = this._queue.then(() => this._dispatch(envelope)).catch((error) => console.error("agent frame failed", error));
    await this._queue;
  }

  /**
   * Send a request to the agent and wait for its response.
   * @param timeoutMs Default is AGENT_REQUEST_TIMEOUT_SEC.
   * @throws AgentRequestError with the agent's error, `timeout`, or `unsupported` when the socket closed.
   */
  public request<T extends keyof PanelToAgentRequests>(
    type: T,
    data: PanelToAgentRequests[T]["request"],
    timeoutMs = Config.AGENT_REQUEST_TIMEOUT_SEC * 1000,
  ): Promise<PanelToAgentRequests[T]["response"]> {
    if (this.phase !== "ready") return Promise.reject(new AgentRequestError("unsupported", "The host disconnected."));
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new AgentRequestError("timeout", `The host did not answer ${String(type)} within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this._pending.set(id, { type: String(type), resolve: resolve as (data: unknown) => void, reject, timer });
      this.send({ kind: "request", id, type: String(type), data });
    });
  }

  /**
   * Send an event to the agent (none are defined yet).
   */
  public notify<T extends keyof PanelToAgentEvents>(type: T, data: PanelToAgentEvents[T]): void {
    this.send({ kind: "event", type: String(type), data });
  }

  /**
   * Write one envelope. Silently drops it when the socket is not open.
   */
  public send(envelope: Envelope): void {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify(envelope));
  }

  /**
   * A new request id for this connection (`p-1`, `p-2`, …; agents use `a-…`).
   */
  public nextRequestId(): string {
    return `p-${this._nextId++}`;
  }

  /**
   * Close the socket with a `CLOSE_*` code. The reason is cut to the 123 bytes WebSocket allows.
   */
  public close(code: number, reason: string): void {
    this.phase = "closed";
    this._clearHelloTimer();
    try {
      this._ws?.close(code, AgentConnection.truncateReason(reason));
    } catch {
      // Already closed.
    }
  }

  /**
   * Called on socket close: reject pending requests and leave the gateway.
   */
  public onClosed(): void {
    this.phase = "closed";
    this._clearHelloTimer();
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentRequestError("unsupported", "The host disconnected."));
    }
    this._pending.clear();
    AgentGateway.unregister(this);
  }

  private _clearHelloTimer(): void {
    if (this._helloTimer === null) return;
    clearTimeout(this._helloTimer);
    this._helloTimer = null;
  }

  private _protocolError(reason: string): void {
    this.close(CLOSE_PROTOCOL_ERROR, reason);
  }

  private _handleResponse(envelope: Envelope): void {
    const pending = envelope.id ? this._pending.get(envelope.id) : undefined;
    if (!pending) return; // Late answer to a request that timed out.
    this._pending.delete(envelope.id!);
    clearTimeout(pending.timer);
    if (envelope.ok) {
      pending.resolve(envelope.data);
    }
    else {
      pending.reject(new AgentRequestError(envelope.error?.code ?? "internal", envelope.error?.message ?? "The host reported an error."));
    }
  }

  private async _dispatch(envelope: Envelope): Promise<void> {
    if (this.phase === "closed") return;
    const type = envelope.type;
    if (typeof type !== "string") return this._protocolError("Frame has no type.");
    const isFirstFrameType = type === "enrol" || type === "hello";

    if (envelope.kind === "event") {
      if (this.phase !== "ready") return this._protocolError("Send enrol or hello first.");
      if (!Object.hasOwn(EVENT_HANDLERS, type)) return;
      try {
        await (EVENT_HANDLERS as Record<string, AnyEventHandler>)[type](this, envelope.data);
      } catch (error) {
        console.error(`agent event ${type} failed`, error);
      }
      return;
    }

    // Request.
    if (typeof envelope.id !== "string") return this._protocolError("Request has no id.");
    if (this.phase === "new" && !isFirstFrameType) return this._protocolError("The first request must be enrol or hello.");
    if (this.phase === "ready" && isFirstFrameType) return this._protocolError(`${type} is only valid as the first request.`);

    if (!Object.hasOwn(REQUEST_HANDLERS, type)) {
      this.send({ kind: "response", id: envelope.id, type, ok: false, error: { code: "unsupported", message: `The panel does not know the request ${type}.` } });
      return;
    }
    try {
      const data = await (REQUEST_HANDLERS as Record<string, AnyRequestHandler>)[type](this, envelope.data);
      this.send({ kind: "response", id: envelope.id, type, ok: true, data });
      if (type === "enrol") this.close(CLOSE_ENROLLED, "Enrolled.");
    } catch (error) {
      const failure = AgentConnection.toFailure(type, error);
      this.send({ kind: "response", id: envelope.id, type, ok: false, error: { code: failure.code, message: failure.message } });
      if (failure instanceof AgentCloseError) this.close(failure.closeCode, failure.message);
      // A failed first request never leaves an unauthenticated socket open.
      else if (isFirstFrameType) this.close(failure.code === "bad_request" ? CLOSE_PROTOCOL_ERROR : CLOSE_INTERNAL_ERROR, failure.message);
    }
  }

  /**
   * Cut a close reason to MAX_CLOSE_REASON_BYTES of UTF-8 without splitting a character.
   */
  private static truncateReason(reason: string): string {
    const encoder = new TextEncoder();
    if (encoder.encode(reason).length <= MAX_CLOSE_REASON_BYTES) return reason;
    let out = "";
    for (const char of reason) {
      if (encoder.encode(out + char + "…").length > MAX_CLOSE_REASON_BYTES) break;
      out += char;
    }
    return `${out}…`;
  }

  /**
   * Turn whatever a handler threw into the error sent to the agent. Unexpected errors are logged, not leaked.
   */
  private static toFailure(type: string, error: unknown): AgentRequestError {
    if (error instanceof AgentRequestError) return error;
    if (error instanceof HttpError) return new AgentRequestError(AgentConnection.codeForStatus(error.status), error.message);
    console.error(`agent request ${type} failed`, error);
    return new AgentRequestError("internal", "The panel failed to handle the request.");
  }

  private static codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400: return "bad_request";
      case 401: return "unauthorized";
      case 403: return "forbidden";
      case 404: return "not_found";
      case 409: return "conflict";
      case 501: return "unsupported";
      default: return "internal";
    }
  }
}

export namespace AgentConnection {
  export type Phase = "new" | "ready" | "closed";

  export interface Pending {
    type: string;
    resolve: (data: unknown) => void;
    reject: (error: AgentRequestError) => void;
    timer: ReturnType<typeof setTimeout>;
  }
}

/**
 * A failed agent request, either way: thrown by handlers (sent as `error`) and raised for the panel's own requests.
 */
export class AgentRequestError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

/**
 * An error that also closes the socket after it is sent, e.g. a refused `hello`.
 */
export class AgentCloseError extends AgentRequestError {
  constructor(
    code: ErrorCode,
    message: string,
    /** WebSocket close code, one of the `CLOSE_*` constants. */
    public readonly closeCode: number,
  ) {
    super(code, message);
    this.name = "AgentCloseError";
  }
}

export default AgentConnection;
