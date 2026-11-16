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
import type { CreateShareBody, ServerShareDto, UpdateShareBody } from "@shared/api/servers.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { User } from "../models/index.ts";

export namespace ShareService {
  /**
   * The server's shares, by username. Needs `owner`.
   */
  export async function list(user: User, serverId: string): Promise<ServerShareDto[]> {
    throw HttpError.notImplemented("ShareService.list"); // TODO(builder): M5
  }

  /**
   * Share the server with another user. Needs `owner`.
   * @throws HttpError 400 self/owner or a bad role, 404 unknown user, 409 already shared or at the limit.
   */
  export async function add(user: User, serverId: string, body: Partial<CreateShareBody>, ip: string | null): Promise<ServerShareDto> {
    throw HttpError.notImplemented("ShareService.add"); // TODO(builder): M5
  }

  /**
   * Change a share's role. Needs `owner`.
   * @throws HttpError 404 when the user has no share on the server.
   */
  export async function update(user: User, serverId: string, userId: number, body: Partial<UpdateShareBody>, ip: string | null): Promise<ServerShareDto> {
    throw HttpError.notImplemented("ShareService.update"); // TODO(builder): M5
  }

  /**
   * Remove a share. Needs `owner`, or `view` when `userId` is the caller (leaving a shared server). Drops the user's
   * `server:<id>` topic (`LiveGateway.dropTopic`) and pushes them a last `server.updated`.
   */
  export async function remove(user: User, serverId: string, userId: number, ip: string | null): Promise<void> {
    throw HttpError.notImplemented("ShareService.remove"); // TODO(builder): M5
  }

  /**
   * A server row was deleted (its shares went with it, ON DELETE CASCADE): drop it from the audience index and drop
   * the shared users' topics. Called by `GameServerService` after its last `server.updated`. Never throws.
   */
  export function forgetServer(serverId: string): void {
    // TODO(builder): M5 sharing. `ServerAccess.forgetServer(serverId)`, then `LiveGateway.dropTopic` for each user.
  }
}

export default ShareService;
