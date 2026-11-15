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
import type { HostGrantDto } from "@shared/api/hosts.ts";
import { ID, intFk, uuidFk } from "./columns.ts";
import type { Host } from "./Host.ts";
import type { User } from "./User.ts";

/**
 * Lets a user create servers on a host (M5). Admins and SERVERS_MANAGE_ALL need no grant.
 */
export class HostGrant extends Model<InferAttributes<HostGrant>, InferCreationAttributes<HostGrant>> {
  declare id: CreationOptional<number>;
  declare hostId: ForeignKey<Host["id"]>;
  declare userId: ForeignKey<User["id"]>;
  declare createdById: ForeignKey<User["id"]> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare user?: NonAttribute<User>;
  declare host?: NonAttribute<Host>;

  public static initModel(sequelize: Sequelize): void {
    HostGrant.init({
      id: ID,
      hostId: uuidFk(false),
      userId: intFk(false),
      createdById: intFk(true),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, {
      sequelize,
      tableName: "host_grants",
      indexes: [{ unique: true, fields: ["host_id", "user_id"] }],
    });
  }

  /**
   * Whether `userId` may use `hostId`.
   */
  public static async isGranted(hostId: string, userId: number): Promise<boolean> {
    return (await HostGrant.count({ where: { hostId, userId } })) > 0;
  }

  /**
   * Needs `user` loaded.
   */
  public toClientJSON(): HostGrantDto {
    return { userId: this.userId, username: this.user?.username ?? "", createdAt: this.createdAt.toISOString() };
  }
}

export type HostGrantAttributes = InferAttributes<HostGrant>;
export default HostGrant;
