import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import { ID, intFk, uuidFk } from "./columns.ts";
import type { GameServer } from "./GameServer.ts";
import type { User } from "./User.ts";

/**
 * Another user's access to a server at a role. The table is planned for v1; the UI comes later.
 */
export class ServerShare extends Model<InferAttributes<ServerShare>, InferCreationAttributes<ServerShare>> {
  declare id: CreationOptional<number>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare userId: ForeignKey<User["id"]>;
  declare role: ServerShare.Role;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

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
