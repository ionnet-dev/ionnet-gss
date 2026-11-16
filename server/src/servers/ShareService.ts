/**
 * Server sharing (M5): list, add, change and remove `ServerShare` rows by username, keep `ServerAccess`'s audience
 * index current, and cut a removed user off the server's live topic at once. Sharing needs the `owner` level (the
 * owner or SERVERS_MANAGE_ALL); a shared user may remove their own share at any level.
 *
 * Rules: not with yourself or the owner (400), unknown username 404, an existing share 409 (change it with
 * `update`), at most `LIMITS.SHARES_PER_SERVER` per server (409). Every change pushes `server.updated` to the
 * server's audience, plus the affected user (a removed one is no longer in it). Audit `server.shared`,
 * `server.share_changed`, `server.unshared` (details: serverId, username, role).
 */
import { UniqueConstraintError } from "sequelize";
import type { CreateShareBody, ServerShareDto, UpdateShareBody } from "@shared/api/servers.ts";
import { LIMITS } from "@shared/constants.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, GameServer, sequelize, ServerShare, User } from "../models/index.ts";
import { ServerAccess } from "./ServerAccess.ts";

export namespace ShareService {
  /**
   * The server's shares, by username. Needs `owner`.
   */
  export async function list(user: User, serverId: string): Promise<ServerShareDto[]> {
    const server = await ServerAccess.get(user, serverId, "owner");
    return (await ServerShare.listForServer(server.id)).map((share) => share.toClientJSON());
  }

  /**
   * Share the server with another user. Needs `owner`.
   * @throws HttpError 400 self/owner or a bad role, 404 unknown user, 409 already shared or at the limit.
   */
  export async function add(user: User, serverId: string, body: Partial<CreateShareBody>, ip: string | null): Promise<ServerShareDto> {
    const server = await ServerAccess.get(user, serverId, "owner");
    const role = verifyRole(body.role);
    if (typeof body.username !== "string" || body.username.trim() === "") throw HttpError.badRequest("Enter the username of the person to share with.");
    const target = await User.findOne({ where: { username: body.username.trim() } });
    if (!target) throw HttpError.notFound(`There is no user named "${body.username.trim()}".`);
    if (target.id === user.id) throw HttpError.badRequest("You can't share a server with yourself.");
    if (target.id === server.ownerId) throw HttpError.badRequest("That user already owns this server.");

    let share: ServerShare;
    try {
      share = await sequelize.transaction(async (transaction) => {
        // Serialise concurrent adds on this server so the limit check and the insert can't interleave.
        await GameServer.findByPk(server.id, { attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
        if (await ServerShare.findOne({ where: { serverId: server.id, userId: target.id }, transaction })) {
          throw HttpError.conflict(`${target.username} already has access to this server. Change their role instead.`);
        }
        if (await ServerShare.count({ where: { serverId: server.id }, transaction }) >= LIMITS.SHARES_PER_SERVER) {
          throw HttpError.conflict(`A server can be shared with at most ${LIMITS.SHARES_PER_SERVER} users.`);
        }
        return await ServerShare.create({ serverId: server.id, userId: target.id, role }, { transaction });
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw HttpError.conflict(`${target.username} already has access to this server. Change their role instead.`);
      throw error;
    }
    share.user = target;
    ServerAccess.rememberShare(server.id, target.id);
    await AuditLog.record({ action: "server.shared", actorId: user.id, hostId: server.hostId, serverId: server.id, details: { serverId: server.id, username: target.username, role }, ip });
    push(server);
    return share.toClientJSON();
  }

  /**
   * Change a share's role. Needs `owner`.
   * @throws HttpError 404 when the user has no share on the server.
   */
  export async function update(user: User, serverId: string, userId: number, body: Partial<UpdateShareBody>, ip: string | null): Promise<ServerShareDto> {
    const server = await ServerAccess.get(user, serverId, "owner");
    const role = verifyRole(body.role);
    const share = await ServerShare.findOne({ where: { serverId: server.id, userId }, include: [{ association: "user" }] });
    if (!share) throw HttpError.notFound("That user has no share on this server.");
    if (share.role !== role) {
      share.role = role;
      await share.save();
      await AuditLog.record({ action: "server.share_changed", actorId: user.id, hostId: server.hostId, serverId: server.id, details: { serverId: server.id, username: share.user?.username, role }, ip });
      push(server);
    }
    return share.toClientJSON();
  }

  /**
   * Remove a share. Needs `owner`, or `view` when `userId` is the caller (leaving a shared server). Drops the user's
   * `server:<id>` topic (`LiveGateway.dropTopic`) and pushes them a last `server.updated`.
   */
  export async function remove(user: User, serverId: string, userId: number, ip: string | null): Promise<void> {
    const server = await ServerAccess.get(user, serverId, userId === user.id ? "view" : "owner");
    const share = await ServerShare.findOne({ where: { serverId: server.id, userId }, include: [{ association: "user" }] });
    if (!share) throw HttpError.notFound("That user has no share on this server.");
    await share.destroy();
    ServerAccess.forgetShare(server.id, userId);
    LiveGateway.dropTopic(userId, `server:${server.id}`);
    await AuditLog.record({ action: "server.unshared", actorId: user.id, hostId: server.hostId, serverId: server.id, details: { serverId: server.id, username: share.user?.username, role: share.role }, ip });
    push(server, userId);
  }

  /**
   * A server row was deleted (its shares went with it, ON DELETE CASCADE): drop it from the audience index and drop
   * the shared users' topics. Called by `GameServerService` after its last `server.updated`. Never throws.
   */
  export function forgetServer(serverId: string): void {
    try {
      for (const userId of ServerAccess.forgetServer(serverId)) LiveGateway.dropTopic(userId, `server:${serverId}`);
    } catch (error) {
      console.error("forgetting a deleted server's shares failed", error);
    }
  }

  function verifyRole(role: unknown): ServerShare.Role {
    if (!ServerShare.isRole(role)) throw HttpError.badRequest(`The role must be one of: ${ServerShare.ROLES.join(", ")}.`);
    return role;
  }

  /**
   * Tell the server's audience to refetch, plus `removedUserId` (a user who just lost access is no longer in it).
   */
  function push(server: GameServer, removedUserId?: number): void {
    LiveGateway.push("server.updated", { serverId: server.id }, ServerAccess.audience(server.id, server.ownerId));
    if (removedUserId !== undefined) LiveGateway.push("server.updated", { serverId: server.id }, { userIds: [removedUserId] });
  }
}

export default ShareService;
