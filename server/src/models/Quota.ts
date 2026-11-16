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
import type { EffectiveQuotaDto, QuotaDto, UpdateQuotaBody } from "@shared/api/users.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ID, intFk } from "./columns.ts";
import type { User } from "./User.ts";

/**
 * Per-user limits. Every field `null` = use the panel default (`DEFAULT_QUOTA_*`). A user without a row uses every
 * default. Admins have no quota. Checked at server create, at every change of a bound limit (settings, upgrade) and
 * at backup create, against the owner's usage (M5; contracts in STRUCTURE.md "M5: tenancy").
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
   * The user's limits with defaults applied (`Config.DEFAULT_QUOTA_*` where a field is null or there is no row), their
   * current usage (`getUsage`), and whether they are exempt (admins).
   * @throws HttpError 404 when the user doesn't exist.
   */
  public static async getEffective(userId: number, transaction?: Transaction): Promise<EffectiveQuotaDto> {
    throw HttpError.notImplemented("Quota.getEffective"); // TODO(builder): M5
  }

  /**
   * What the user uses now, over their own servers whose state isn't `deleting`: server count, memory and CPU (game
   * limits plus `DefinitionEngine.serviceTotals` of each server's definition), disk (sum of `diskMb`), and backups
   * that aren't `failed`.
   */
  public static async getUsage(userId: number, transaction?: Transaction): Promise<EffectiveQuotaDto["used"]> {
    throw HttpError.notImplemented("Quota.getUsage"); // TODO(builder): M5
  }

  /**
   * Refuse a change that would take the owner past their quota (admins pass). Locks the user's row first
   * (`SELECT … FOR UPDATE`), so concurrent checks for one user take turns; call it inside the transaction that also
   * writes the change (row insert, new limits), before any host row lock (order: user, then host). Only the fields in
   * `delta` are checked, and only growth: a quota lowered below the current usage blocks growth, nothing else.
   * @param delta What the change adds.
   * @param opts `actorId`: the caller, when it isn't the owner (the message then says "the owner's quota").
   * @throws HttpError 409 naming the limit, e.g. "This would use 6144 MB of RAM; your quota is 4096 MB."
   */
  public static async assertFits(userId: number, delta: Quota.Delta, transaction?: Transaction, opts?: { actorId?: number }): Promise<void> {
    // TODO(builder): M5 quota. Until then every change fits (the M2 behaviour).
  }

  /**
   * Store new overrides (absent = unchanged, null = default), creating the row on first use.
   * @throws HttpError 400 for a value that isn't a whole number 0 … 2^31-1 or null.
   */
  public static async setOverrides(userId: number, body: UpdateQuotaBody, transaction?: Transaction): Promise<Quota> {
    throw HttpError.notImplemented("Quota.setOverrides"); // TODO(builder): M5
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

export namespace Quota {
  /**
   * What a change adds to a user's usage. Omitted fields aren't checked.
   */
  export interface Delta {
    servers?: number;
    memoryMb?: number; // Game plus stack services.
    cpuMillis?: number; // Game plus stack services; 1000 = one CPU.
    diskMb?: number;
    backups?: number;
  }
}

export type QuotaAttributes = InferAttributes<Quota>;
export default Quota;
