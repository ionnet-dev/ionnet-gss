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
 * An archive of a server's data folder, stored on its host (M4). Counts against the owner's `maxBackups`.
 */
export class Backup extends Model<InferAttributes<Backup>, InferCreationAttributes<Backup>> {
  declare id: CreationOptional<number>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare createdById: ForeignKey<User["id"]> | null; // null = a schedule.
  declare name: string;
  declare status: CreationOptional<Backup.Status>;
  declare file: string | null; // Path on the host, relative to the server folder.
  declare sizeBytes: number | null;
  declare error: string | null;
  declare startedAt: Date | null;
  declare finishedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Backup.init({
      id: ID,
      serverId: uuidFk(false),
      createdById: intFk(true),
      name: { type: DataTypes.STRING(128), allowNull: false },
      status: { type: DataTypes.ENUM(...Backup.STATUSES), allowNull: false, defaultValue: "pending" },
      file: { type: DataTypes.STRING(255), allowNull: true },
      sizeBytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "backups" });
  }
}

export namespace Backup {
  export const STATUSES = ["pending", "running", "done", "failed"] as const;
  export type Status = typeof STATUSES[number];

  export function validateStatus(value: unknown): value is Status {
    return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
  }
}

export type BackupAttributes = InferAttributes<Backup>;
export default Backup;
