import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import type { EffectiveQuotaDto, QuotaDto } from "@shared/api/users.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ID, intFk } from "./columns.ts";
import type { User } from "./User.ts";

/**
 * Per-user limits. Every field `null` = use the panel default (`DEFAULT_QUOTA_*`). A user without a row uses every
 * default. Admins have no quota. Checked at server create and at every change of a bound variable (M5).
 */
export class Quota extends Model<InferAttributes<Quota>, InferCreationAttributes<Quota>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User["id"]>;
  declare maxServers: number | null; // null = DEFAULT_QUOTA_SERVERS
  declare maxMemoryMb: number | null; // null = DEFAULT_QUOTA_MEMORY_MB
  declare maxCpuMillis: number | null; // null = DEFAULT_QUOTA_CPU_MILLIS (1000 = one CPU)
  declare maxDiskMb: number | null; // null = DEFAULT_QUOTA_DISK_MB
  declare maxBackups: number | null; // null = DEFAULT_QUOTA_BACKUPS
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Quota.init({
      id: ID,
      userId: { ...intFk(false), unique: true },
      maxServers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxMemoryMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxCpuMillis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxDiskMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxBackups: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "quotas" });
  }

  /**
   * The user's limits with defaults applied, and their current usage (servers, summed limits, backups). M5.
   */
  public static async getEffective(userId: number): Promise<EffectiveQuotaDto> {
    throw HttpError.notImplemented("Quota.getEffective"); // TODO(builder): M5
  }

  /**
   * Refuse a new server or a limit change that would exceed the owner's quota (admins pass). M2: always passes; M5
   * fills it in with `getEffective()`.
   * @param delta What the change adds: one more server and/or more memory/CPU/disk.
   * @throws HttpError 409 naming the limit, e.g. "This would use 6144 MB of RAM; your quota is 4096 MB."
   */
  public static async assertFits(userId: number, delta: { servers: number; memoryMb: number; cpuMillis: number; diskMb: number }): Promise<void> {
    // TODO(builder): M5
  }

  public toClientJSON(): QuotaDto {
    return {
      maxServers: this.maxServers,
      maxMemoryMb: this.maxMemoryMb,
      maxCpuMillis: this.maxCpuMillis,
      maxDiskMb: this.maxDiskMb,
      maxBackups: this.maxBackups,
    };
  }
}

export type QuotaAttributes = InferAttributes<Quota>;
export default Quota;
