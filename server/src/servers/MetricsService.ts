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
import { LIMITS } from "@shared/constants.ts";
import {
  PLAYER_NAME_MAX_CHARS,
  PLAYERS_MAX,
  type PlayerEvent,
  type ServerState,
  type ServerStatus,
  type StatsBatch,
} from "@shared/protocol/protocol.gen.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { GameServer, type User } from "../models/index.ts";
import MetricRing from "./MetricRing.ts";
import ServerAccess from "./ServerAccess.ts";

export namespace MetricsService {
  interface Entry {
    ring: MetricRing;
    disk: { bytes: number; measuredAt: Date } | null;
    players: string[];
  }

  const MAX_SKEW_MS = 60_000; // An agent clock further off than this is replaced by the panel's.

  const _entries = new Map<string, Entry>();
  const _hostOf = new Map<string, Promise<string | null>>(); // server → host, like `forwardConsole`.

  function entryOf(serverId: string): Entry {
    let entry = _entries.get(serverId);
    if (!entry) {
      entry = { ring: new MetricRing(LIMITS.METRICS_HISTORY_SAMPLES), disk: null, players: [] };
      _entries.set(serverId, entry);
    }
    return entry;
  }

  /**
   * Whether the server exists and lives on `hostId` (so a host can't write another host's server).
   */
  async function isOnHost(hostId: string, serverId: string): Promise<boolean> {
    let lookup = _hostOf.get(serverId);
    if (!lookup) {
      lookup = GameServer.findByPk(serverId, { attributes: ["id", "hostId"] }).then((row) => row?.hostId ?? null);
      _hostOf.set(serverId, lookup);
    }
    try {
      const owner = await lookup;
      if (owner === null) {
        _hostOf.delete(serverId); // Not stored yet or gone: look again next time.
        if (_entries.has(serverId)) forget(serverId);
        return false;
      }
      return owner === hostId;
    }
    catch (error) {
      _hostOf.delete(serverId);
      throw error;
    }
  }

  function pushPlayers(serverId: string, players: string[]): void {
    LiveGateway.push("server.players", { serverId, players: [...players] }, { topic: `server:${serverId}` });
  }

  function isLive(state: ServerState): boolean {
    return state === "starting" || state === "running";
  }

  /**
   * `GET /api/servers/:id/metrics` (ServerAccess `view`). `playersSupported` = the pinned definition has `players`.
   */
  export async function get(user: User, serverId: string): Promise<ServerMetricsResponse> {
    const server = await ServerAccess.get(user, serverId, "view", { include: [{ association: "definition", attributes: ["id", "document"] }] });
    const entry = _entries.get(server.id);
    const players = server.definition?.document.players;
    return {
      samples: entry?.ring.samples() ?? [],
      disk: entry?.disk ? { bytes: entry.disk.bytes, limitBytes: server.diskMb * 1024 * 1024, measuredAt: entry.disk.measuredAt.toISOString() } : null,
      players: entry ? [...entry.players] : [],
      playersSupported: Boolean(players?.join || players?.leave),
    };
  }

  /**
   * `server.stats` event from a host.
   */
  export async function recordStats(hostId: string, batch: StatsBatch): Promise<void> {
    const now = Date.now();
    const parsed = Date.parse(batch.at);
    const at = new Date(Number.isFinite(parsed) && Math.abs(parsed - now) <= MAX_SKEW_MS ? parsed : now);
    for (const stats of batch.servers) {
      const serverId = stats.serverId.toLowerCase();
      if (!await isOnHost(hostId, serverId)) continue;
      const entry = entryOf(serverId);
      const sample = entry.ring.push(stats, at);
      if (!sample) continue;
      if (stats.diskBytes !== null && stats.diskBytes !== undefined) entry.disk = { bytes: stats.diskBytes, measuredAt: at };
      LiveGateway.push("server.stats", { serverId, sample, diskBytes: stats.diskBytes ?? null }, { topic: `server:${serverId}` });
    }
  }

  /**
   * `server.player` event from a host.
   */
  export async function applyPlayer(hostId: string, event: PlayerEvent): Promise<void> {
    const serverId = event.serverId.toLowerCase();
    if (!await isOnHost(hostId, serverId)) return;
    const entry = entryOf(serverId);
    const name = event.player.slice(0, PLAYER_NAME_MAX_CHARS);
    const index = entry.players.indexOf(name);
    if (event.action === "join") {
      if (index >= 0 || entry.players.length >= PLAYERS_MAX) return;
      entry.players.push(name);
    }
    else {
      if (index < 0) return;
      entry.players.splice(index, 1);
    }
    pushPlayers(serverId, entry.players);
  }

  /**
   * Called by the `server.state` handler after the row was updated.
   */
  export function onStateChange(serverId: string, state: ServerState): void {
    if (isLive(state)) return;
    const entry = _entries.get(serverId);
    if (!entry) return;
    entry.ring.resetRates();
    if (entry.players.length > 0) {
      entry.players = [];
      pushPlayers(serverId, entry.players);
    }
  }

  /**
   * After a hello: seed player lists from the inventory.
   */
  export function seedFromHello(hostId: string, servers: ServerStatus[]): void {
    for (const status of servers) {
      if (!Array.isArray(status.players)) continue; // An older agent: leave the list alone.
      const serverId = status.serverId.toLowerCase();
      const players = isLive(status.state)
        ? [...new Set(status.players.filter((name) => typeof name === "string" && name !== "").map((name) => name.slice(0, PLAYER_NAME_MAX_CHARS)))].slice(0, PLAYERS_MAX)
        : [];
      isOnHost(hostId, serverId).then((onHost) => {
        if (!onHost) return;
        const entry = entryOf(serverId);
        if (entry.players.length === players.length && entry.players.every((name, i) => name === players[i])) return;
        entry.players = players;
        pushPlayers(serverId, players);
      }).catch((error) => console.error("player seed failed", error));
    }
  }

  /**
   * Drop a deleted server's history and players.
   */
  export function forget(serverId: string): void {
    _entries.delete(serverId);
    _hostOf.delete(serverId);
  }

  /**
   * Current players of a server (empty when unknown).
   */
  export function playersOf(serverId: string): string[] {
    return [...(_entries.get(serverId)?.players ?? [])];
  }
}

export default MetricsService;
