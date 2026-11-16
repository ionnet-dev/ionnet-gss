import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
} from "sequelize";
import type { ServerShareDto } from "@shared/api/servers.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ID, intFk, uuidFk } from "./columns.ts";
import type { GameServer } from "./GameServer.ts";
import type { User } from "./User.ts";

/**
 * Another user's access to a server at a role (M5). The owner and SERVERS_MANAGE_ALL never have a row (they hold
 * `owner`, see `ServerAccess`). Unique per (server, user).
 */
export class ServerShare extends Model<InferAttributes<ServerShare>, InferCreationAttributes<ServerShare>> {
  declare id: CreationOptional<number>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare userId: ForeignKey<User["id"]>;
  declare role: ServerShare.Role;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;

  public static initModel(sequelize: Sequelize): void {
    ServerShare.init({
      id: ID,
      serverId: uuidFk(false),
      userId: intFk(false),
      role: { type: DataTypes.ENUM(...ServerShare.ROLES), allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, {
      sequelize,
      tableName: "server_shares",
      indexes: [{ unique: true, fields: ["server_id", "user_id"] }],
    });
  }

  /**
   * Whether `value` is a share role.
   */
  public static isRole(value: unknown): value is ServerShare.Role {
    return typeof value === "string" && (ServerShare.ROLES as readonly string[]).includes(value);
  }

  /**
   * The shares of a server with `user` loaded, by username.
   */
  public static async listForServer(serverId: string): Promise<ServerShare[]> {
    throw HttpError.notImplemented("ServerShare.listForServer"); // TODO(builder): M5
  }

  /**
   * Every share as `[serverId, userId]`, for `ServerAccess.init()`'s audience index.
   */
  public static async allPairs(): Promise<[string, number][]> {
    const rows = await ServerShare.findAll({ attributes: ["serverId", "userId"], raw: true });
    return rows.map((row) => [row.serverId, row.userId]);
  }

  /**
   * Needs `user` loaded.
   */
  public toClientJSON(): ServerShareDto {
    throw HttpError.notImplemented("ServerShare.toClientJSON"); // TODO(builder): M5
  }
}

export namespace ServerShare {
  /**
   * view: console and stats; operate: + start/stop/console input; manage: + settings, files, backups.
   */
  export const ROLES = ["view", "operate", "manage"] as const;
  export type Role = typeof ROLES[number];
}

export type ServerShareAttributes = InferAttributes<ServerShare>;
export default ServerShare;
