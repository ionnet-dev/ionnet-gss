/**
 * Live metrics and players (M4), in memory only: a `MetricRing` per server (about an hour), the last disk measurement,
 * and the current player list. Nothing goes to the database; a panel restart starts with empty charts, and the player
 * lists come back with the next hello (`ServerStatus.players`).
 *
 *   server.stats   per sample: check the server is on that host (cache server → host like `forwardConsole`), push
 *                  into its ring, push `server.stats` to `server:<id>`.
 *   server.player  join/leave on the server's list (≤ PLAYERS_MAX, names ≤ PLAYER_NAME_MAX_CHARS), push the whole
 *                  list as `server.players` to `server:<id>`.
 *   state change   leaving starting/running clears the list (push it) and resets the ring's rate baseline.
 *   hello          `ServerStatus.players` replaces each listed server's list (absent = an older agent: untouched).
 *   delete         `forget(serverId)`.
 */
import type { ServerMetricsResponse } from "@shared/api/metrics.ts";
import type { PlayerEvent, ServerState, ServerStatus, StatsBatch } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { User } from "../models/index.ts";

export namespace MetricsService {
  /**
   * `GET /api/servers/:id/metrics` (ServerAccess `view`). `playersSupported` = the pinned definition has `players`.
   */
  export async function get(user: User, serverId: string): Promise<ServerMetricsResponse> {
    throw HttpError.notImplemented("MetricsService.get"); // TODO(builder)
  }

  /**
   * `server.stats` event from a host.
   */
  export async function recordStats(hostId: string, batch: StatsBatch): Promise<void> {
    // TODO(builder): implement. A no-op until then (runs on the live agent path).
  }

  /**
   * `server.player` event from a host.
   */
  export async function applyPlayer(hostId: string, event: PlayerEvent): Promise<void> {
    // TODO(builder): implement. A no-op until then (runs on the live agent path).
  }

  /**
   * Called by the `server.state` handler after the row was updated.
   */
  export function onStateChange(serverId: string, state: ServerState): void {
    // TODO(builder): implement. A no-op until then (runs on the live agent path).
  }

  /**
   * After a hello: seed player lists from the inventory.
   */
  export function seedFromHello(hostId: string, servers: ServerStatus[]): void {
    // TODO(builder): implement. A no-op until then (runs on every hello).
  }

  /**
   * Drop a deleted server's history and players.
   */
  export function forget(serverId: string): void {
    // TODO(builder)
  }

  /**
   * Current players of a server (empty when unknown).
   */
  export function playersOf(serverId: string): string[] {
    return []; // TODO(builder)
  }
}

export default MetricsService;
