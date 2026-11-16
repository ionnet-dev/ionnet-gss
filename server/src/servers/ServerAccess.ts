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
   * Revocation log for live subscribes: a logical clock and, per `serverId:userId` (or `serverId:*` for a deleted
   * server), the clock value when access was last taken away. A subscribe that awaited its database check compares
   * against it (`revokedSince`) right before it adds the topic, so a removal that ran in that gap isn't undone.
   * Bounded: only removals made within one subscribe's await matter, so the oldest entries are dropped past the cap.
   */
  let _clock = 0;
  const _revoked = new Map<string, number>();
  const REVOKED_CAP = 1000;

  function revoke(serverId: string, userId: number | "*"): void {
    const key = `${serverId}:${userId}`;
    _revoked.delete(key); // Re-insert so the Map stays ordered by time.
    _revoked.set(key, ++_clock);
    if (_revoked.size > REVOKED_CAP) _revoked.delete(_revoked.keys().next().value!);
  }

  /**
   * The current value of the revocation clock. Read it before an `await` that decides access, then pass it to
   * `revokedSince` after.
   */
  export function clock(): number {
    return _clock;
  }

  /**
   * Whether the user's access to the server (or the server itself) was removed after `since` (a `clock()` value).
   */
  export function revokedSince(serverId: string, userId: number, since: number): boolean {
    return (_revoked.get(`${serverId}:${userId}`) ?? 0) > since || (_revoked.get(`${serverId}:*`) ?? 0) > since;
  }

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
    _sharedWith.clear();
    for (const [serverId, userId] of await ServerShare.allPairs()) rememberShare(serverId, userId);
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
    const all = user.hasPermission("SERVERS_MANAGE_ALL");
    const shared = new Map<string, ServerShare.Role>();
    if (all) return { all, shared };
    const rows = await ServerShare.findAll({ where: { userId: user.id }, attributes: ["serverId", "role"] });
    for (const row of rows) shared.set(row.serverId, row.role);
    return { all, shared };
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
    let users = _sharedWith.get(serverId);
    if (!users) _sharedWith.set(serverId, users = new Set());
    users.add(userId);
  }

  /**
   * Remove a share from the audience index (after the row is deleted).
   */
  export function forgetShare(serverId: string, userId: number): void {
    revoke(serverId, userId);
    const users = _sharedWith.get(serverId);
    if (!users) return;
    users.delete(userId);
    if (users.size === 0) _sharedWith.delete(serverId);
  }

  /**
   * Drop a deleted server from the audience index.
   * @returns The user ids it was shared with (so the caller can drop their topics).
   */
  export function forgetServer(serverId: string): number[] {
    revoke(serverId, "*");
    const users = _sharedWith.get(serverId);
    _sharedWith.delete(serverId);
    return users ? [...users] : [];
  }

  function notFound(): HttpError {
    return HttpError.notFound("There is no game server with that id.");
  }
}

export default ServerAccess;
