import {
  col,
  type CreationOptional,
  DataTypes,
  fn,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
} from "sequelize";
import { SERVER_STATE_VALUES, type ServerState } from "@shared/protocol/protocol.gen.ts";
import { jsonColumn, UUID_ID, intFk, uuidFk } from "./columns.ts";
import type { Definition } from "./Definition.ts";
import type { Host } from "./Host.ts";
import type { PortAllocation } from "./PortAllocation.ts";
import type { User } from "./User.ts";

/**
 * One game instance owned by a user, on one host, pinned to one definition version (M2). Its id names the folder
 * (`/var/lib/ionnet-gss/servers/<id>`) and the containers on the host.
 */
export class GameServer extends Model<InferAttributes<GameServer>, InferCreationAttributes<GameServer>> {
  declare id: CreationOptional<string>; // UUID
  declare name: string;
  declare ownerId: ForeignKey<User["id"]>;
  declare hostId: ForeignKey<Host["id"]>;
  declare definitionId: ForeignKey<Definition["id"]>;
  declare state: CreationOptional<ServerState>; // Last state the agent reported (or "creating").
  declare stateReason: string | null; // Readable cause of install_failed / crashed.
  declare lastExitCode: number | null;
  declare stateChangedAt: CreationOptional<Date>;
  declare variables: CreationOptional<Record<string, string | number | boolean>>; // Values by key, secrets included (never sent to the browser).
  declare memoryMb: number;
  declare cpuMillis: number; // 1000 = one CPU.
  declare diskMb: number; // Soft limit.
  declare autostart: CreationOptional<boolean>; // Start after a host reboot if it was running.
  declare autoRestart: CreationOptional<boolean>; // Restart after a crash (3 in 10 minutes).
  declare specHash: string | null; // Hash of the spec last provisioned; null = never provisioned.
  declare installedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare owner?: NonAttribute<User>;
  declare host?: NonAttribute<Host>;
  declare definition?: NonAttribute<Definition>;
  declare ports?: NonAttribute<PortAllocation[]>;

  public static initModel(sequelize: Sequelize): void {
    GameServer.init({
      id: UUID_ID,
      name: { type: DataTypes.STRING(64), allowNull: false },
      ownerId: intFk(false),
      hostId: uuidFk(false),
      definitionId: intFk(false),
      state: { type: DataTypes.ENUM(...SERVER_STATE_VALUES), allowNull: false, defaultValue: "creating" },
      stateReason: { type: DataTypes.TEXT, allowNull: true },
      lastExitCode: { type: DataTypes.INTEGER, allowNull: true },
      stateChangedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      variables: { ...jsonColumn("variables", false, {}), defaultValue: {} },
      memoryMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      cpuMillis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      diskMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      autostart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      autoRestart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      specHash: { type: DataTypes.CHAR(64), allowNull: true },
      installedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "game_servers" });
  }

  /**
   * Game servers per host in one grouped query. Hosts without servers are missing from the map (count 0).
   * @param hostIds Only count these hosts; omit to count every host.
   */
  public static async countByHost(hostIds?: string[]): Promise<Map<string, number>> {
    if (hostIds?.length === 0) return new Map();
    const rows = await GameServer.findAll({
      attributes: ["hostId", [fn("COUNT", col("id")), "count"]],
      where: hostIds ? { hostId: hostIds } : undefined,
      group: ["hostId"],
      raw: true,
    }) as unknown as { hostId: string; count: number | string }[];
    return new Map(rows.map((row) => [row.hostId, Number(row.count)]));
  }
}

export type GameServerAttributes = InferAttributes<GameServer>;
export default GameServer;
