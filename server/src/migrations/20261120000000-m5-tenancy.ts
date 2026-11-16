/**
 * M5: the TOTP replay guard (`users.totp_last_step`, the last 30 s time step a code was accepted for; INTEGER fits
 * until the year 6000) and single-use recovery codes, stored as SHA-256 only. Quotas, host grants and server shares
 * exist since the initial schema.
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("users", "totp_last_step", { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  await qi.createTable("recovery_codes", {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
    code_hash: { type: DataTypes.CHAR(64), allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex("recovery_codes", ["user_id"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("recovery_codes");
  await qi.removeColumn("users", "totp_last_step");
}
