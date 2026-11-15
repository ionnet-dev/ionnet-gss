import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import { intFk, jsonColumn } from "./columns.ts";
import type { User } from "./User.ts";

/**
 * Who did what. Host and server ids are kept without foreign keys so entries outlive what they describe.
 */
export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<number>;
  declare actorId: ForeignKey<User["id"]> | null; // null = the panel or an agent.
  declare action: string; // Dotted, e.g. "host.enrolled", "user.created", "server.started".
  declare hostId: string | null;
  declare serverId: string | null;
  declare details: Record<string, unknown> | null;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    AuditLog.init({
      id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      actorId: intFk(true),
      action: { type: DataTypes.STRING(64), allowNull: false },
      hostId: { type: DataTypes.UUID, allowNull: true },
      serverId: { type: DataTypes.UUID, allowNull: true },
      details: jsonColumn("details", true, null),
      ip: { type: DataTypes.STRING(45), allowNull: true },
      createdAt: DataTypes.DATE,
    }, { sequelize, tableName: "audit_logs", updatedAt: false });
  }

  /**
   * Write one entry. Never throws: a failed audit write is logged, not surfaced to the caller.
   */
  public static async record(entry: AuditLog.Entry): Promise<void> {
    try {
      await AuditLog.create({
        actorId: entry.actorId ?? null,
        action: entry.action,
        hostId: entry.hostId ?? null,
        serverId: entry.serverId ?? null,
        details: entry.details ?? null,
        ip: entry.ip ?? null,
      });
    } catch (error) {
      console.error("audit log write failed", entry.action, error);
    }
  }
}

export namespace AuditLog {
  export interface Entry {
    action: string;
    actorId?: number | null;
    hostId?: string | null;
    serverId?: string | null;
    details?: Record<string, unknown> | null;
    ip?: string | null;
  }
}

export type AuditLogAttributes = InferAttributes<AuditLog>;
export default AuditLog;
