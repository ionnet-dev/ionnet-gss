/**
 * Handlers for what agents send, by message type. `AgentConnection.handleFrame()` looks the type up here.
 * Every request type must have a handler (the mapped type enforces it); event types may be missing (logged, ignored).
 * A new agent → panel message: schema in protocol/, `deno task protocol`, a `<name>.ts` here, one line below.
 */
import type { AgentToPanelEvents, AgentToPanelRequests } from "@shared/protocol/protocol.gen.ts";
import type { AgentConnection } from "../AgentConnection.ts";
import { handleEnrol } from "./enrol.ts";
import { handleHello } from "./hello.ts";
import { handleHeartbeat } from "./heartbeat.ts";
import { handleServerConsole } from "./serverConsole.ts";
import { handleServerServices } from "./serverServices.ts";
import { handleServerState } from "./serverState.ts";

export type AgentRequestHandler<T extends keyof AgentToPanelRequests> = (
  conn: AgentConnection,
  data: AgentToPanelRequests[T]["request"],
) => Promise<AgentToPanelRequests[T]["response"]>;

export type AgentEventHandler<T extends keyof AgentToPanelEvents> = (
  conn: AgentConnection,
  data: AgentToPanelEvents[T],
) => Promise<void>;

export const REQUEST_HANDLERS: { [T in keyof AgentToPanelRequests]: AgentRequestHandler<T> } = {
  "enrol": handleEnrol,
  "hello": handleHello,
};

export const EVENT_HANDLERS: { [T in keyof AgentToPanelEvents]?: AgentEventHandler<T> } = {
  "heartbeat": handleHeartbeat,
  "server.state": handleServerState,
  "server.console": handleServerConsole,
  "server.services": handleServerServices,
  // M4: "server.stats", "server.player"
};
