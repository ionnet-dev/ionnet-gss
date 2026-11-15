/**
 * Who may do what to a server (M4): the owner and SERVERS_MANAGE_ALL may do everything; another user needs a
 * `ServerShare` whose role is at least the level asked for (view < operate < manage). Everyone else gets a 404, so
 * server ids can't be probed. The file manager and backups need `manage`; metrics need `view`.
 *
 * `GameServerService.getAccessible` predates sharing (owner or SERVERS_MANAGE_ALL only); it moves onto this when the
 * sharing UI lands.
 */
import type { FindOptions } from "sequelize";
import { HttpError } from "../lib/HttpError.ts";
import { GameServer, ServerShare, type User } from "../models/index.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export namespace ServerAccess {
  export type Level = ServerShare.Role;

  const RANK: Record<Level, number> = { view: 1, operate: 2, manage: 3 };

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
    if (held === null || RANK[held] < RANK[level]) throw notFound();
    return server;
  }

  /**
   * The highest level the user holds on the server, or null for none.
   */
  export async function levelOf(user: User, server: GameServer): Promise<Level | null> {
    if (server.ownerId === user.id || user.hasPermission("SERVERS_MANAGE_ALL")) return "manage";
    const share = await ServerShare.findOne({ where: { serverId: server.id, userId: user.id }, attributes: ["role"] });
    return share?.role ?? null;
  }

  /**
   * Whether `held` covers `level`.
   */
  export function covers(held: Level | null, level: Level): boolean {
    return held !== null && RANK[held] >= RANK[level];
  }

  function notFound(): HttpError {
    return HttpError.notFound("There is no game server with that id.");
  }
}

export default ServerAccess;
