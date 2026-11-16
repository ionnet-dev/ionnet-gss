/**
 * M7: email. `settings` holds panel settings edited in the UI (key → JSON; the mail relay first). `email_tokens` holds
 * every link and code the panel emails (confirm, reset, welcome, login, action), as SHA-256 only. Users gain the
 * confirmed time of their address, a pending new address, the email two-factor switch, and whether a password was
 * ever set (accounts created for a welcome link have none).
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("settings", {
    key: { type: DataTypes.STRING(64), primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable("email_tokens", {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
    purpose: { type: DataTypes.STRING(16), allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: false },
    attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex("email_tokens", ["token_hash"]);
  await qi.addIndex("email_tokens", ["user_id", "purpose"]);
  await qi.addColumn("users", "email_verified_at", { type: DataTypes.DATE, allowNull: true });
  await qi.addColumn("users", "pending_email", { type: DataTypes.STRING(255), allowNull: true });
  await qi.addColumn("users", "email_two_factor", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await qi.addColumn("users", "has_password", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("users", "has_password");
  await qi.removeColumn("users", "email_two_factor");
  await qi.removeColumn("users", "pending_email");
  await qi.removeColumn("users", "email_verified_at");
  await qi.dropTable("email_tokens");
  await qi.dropTable("settings");
}
