import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
  type Transaction,
} from "sequelize";
import { PORT_PROTO_VALUES, type PortDecl, type PortProto } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ID, uuidFk } from "./columns.ts";
import type { GameServer } from "./GameServer.ts";
import type { Host } from "./Host.ts";

/**
 * A published port taken from a host's pool (M2). The same number is used on the host and inside the container.
 * Internal ports (`internal: true` in game.yml) need no allocation: each server has its own network.
 */
export class PortAllocation extends Model<InferAttributes<PortAllocation>, InferCreationAttributes<PortAllocation>> {
  declare id: CreationOptional<number>;
  declare hostId: ForeignKey<Host["id"]>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare name: string; // Port name from the definition, e.g. "game".
  declare proto: PortProto;
  declare port: number;
  declare pinned: CreationOptional<boolean>; // Chosen by an admin (PORTS_OVERRIDE) rather than allocated.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    PortAllocation.init({
      id: ID,
      hostId: uuidFk(false),
      serverId: uuidFk(false),
      name: { type: DataTypes.STRING(32), allowNull: false },
      proto: { type: DataTypes.ENUM(...PORT_PROTO_VALUES), allowNull: false },
      port: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, {
      sequelize,
      tableName: "port_allocations",
      indexes: [{ unique: true, fields: ["host_id", "proto", "port"] }],
    });
  }

  /**
   * Allocate every published port of a definition for a new server: the declared `default` when free and in the
   * pool, else the lowest free port in the pool. The unique index settles races (retry on conflict).
   * @throws HttpError 409 naming the pool when it is exhausted.
   */
  public static async allocate(host: Host, serverId: string, ports: PortDecl[], transaction: Transaction): Promise<PortAllocation[]> {
    throw HttpError.notImplemented("PortAllocation.allocate"); // TODO(builder): M2
  }
}

export type PortAllocationAttributes = InferAttributes<PortAllocation>;
export default PortAllocation;
