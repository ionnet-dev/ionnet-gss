/**
 * Who may do what to a server: the owner and SERVERS_MANAGE_ALL hold `owner`; another user holds the role of their
 * `ServerShare` (view < operate < manage). Below the level asked → 404, so server ids can't be probed. The level
 * each operation needs is the table in STRUCTURE.md "M5: tenancy" (view: read; operate: power and console input;
 * manage: settings, files, backups; owner: delete and sharing).
 *
 * Live audiences (`audience()`) are synchronous because they are built on the agent event path; they read an
 * in-memory index of shares (`serverId → userIds`), loaded by `init()` at startup and kept current by `ShareService`
 * (`rememberShare`, `forgetShare`, `forgetServer`). One panel process writes shares, so the index can't drift.
 */
import type { FindOptions } from "sequelize";
import type { ServerAccessLevel } from "@shared/api/servers.ts";
import type { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { GameServer, ServerShare, type User } from "../models/index.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export namespace ServerAccess {
  export type Level = ServerAccessLevel;

  const RANK: Record<Level, number> = { view: 1, operate: 2, manage: 3, owner: 4 };

  /**
   * Shared user ids by server id (the audience index).
   */
  const _sharedWith = new Map<string, Set<number>>();

  /**
   * What a user can list: everything (SERVERS_MANAGE_ALL), else their own servers plus `shared`.
   */
  export interface Scope {
    all: boolean;
    shared: Map<string, ServerShare.Role>; // Server id → the user's share role.
  }

  /**
   * Load the audience index from `server_shares`. Called once at startup, after the database is up.
   */
  export async function init(): Promise<void> {
    // TODO(builder): M5 sharing. Fill `_sharedWith` from `ServerShare.allPairs()`.
  }

  /**
   * The server if the user holds at least `level` on it.
   * @param include Extra find options (e.g. `{ include: [{ association: "host" }] }`).
   * @throws HttpError 404 when the server doesn't exist or the user may not reach it at that level.
   */
  export async function get(user: User, serverId: string, level: Level, options?: Omit<FindOptions<GameServer>, "where">): Promise<GameServer> {
    if (!UUID_PATTERN.test(serverId)) throw notFound();
    const server = await GameServer.findByPk(serverId.toLowerCase(), options);
    if (!server) throw notFound();
    const held = await levelOf(user, server);
    if (!covers(held, level)) throw notFound();
    return server;
  }

  /**
   * The highest level the user holds on the server, or null for none.
   */
  export async function levelOf(user: User, server: GameServer): Promise<Level | null> {
    if (server.ownerId === user.id || user.hasPermission("SERVERS_MANAGE_ALL")) return "owner";
    const share = await ServerShare.findOne({ where: { serverId: server.id, userId: user.id }, attributes: ["role"] });
    return share?.role ?? null;
  }

  /**
   * The level for a server in a list built from `scopeOf(user)`, without another query.
   */
  export function levelIn(scope: Scope, user: User, server: GameServer): Level {
    if (scope.all || server.ownerId === user.id) return "owner";
    return scope.shared.get(server.id) ?? "view";
  }

  /**
   * What `user` may list (`GameServerService.list`).
   */
  export async function scopeOf(user: User): Promise<Scope> {
    // TODO(builder): M5 sharing. Load the user's shares into `shared`.
    return { all: user.hasPermission("SERVERS_MANAGE_ALL"), shared: new Map() };
  }

  /**
   * Whether `held` covers `level`.
   */
  export function covers(held: Level | null, level: Level): boolean {
    return held !== null && RANK[held] >= RANK[level];
  }

  /**
   * Who gets a server's non-topic events (`server.updated`, `server.state`, `server.services`, `backup.updated`):
   * SERVERS_MANAGE_ALL, the owner and every user it is shared with.
   */
  export function audience(serverId: string, ownerId: number): LiveGateway.Audience {
    const shared = _sharedWith.get(serverId);
    return { permission: "SERVERS_MANAGE_ALL", userIds: shared ? [ownerId, ...shared] : [ownerId] };
  }

  /**
   * Add a share to the audience index (after the row is stored).
   */
  export function rememberShare(serverId: string, userId: number): void {
    // TODO(builder): M5 sharing
  }

  /**
   * Remove a share from the audience index (after the row is deleted).
   */
  export function forgetShare(serverId: string, userId: number): void {
    // TODO(builder): M5 sharing
  }

  /**
   * Drop a deleted server from the audience index.
   * @returns The user ids it was shared with (so the caller can drop their topics).
   */
  export function forgetServer(serverId: string): number[] {
    // TODO(builder): M5 sharing
    return [];
  }

  function notFound(): HttpError {
    return HttpError.notFound("There is no game server with that id.");
  }
}

export default ServerAccess;
