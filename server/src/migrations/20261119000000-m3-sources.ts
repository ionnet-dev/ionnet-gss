/**
 * M3: git source settings (optional token, own sync interval) and the last known stack service states per server.
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("sources", "auth_token", { type: DataTypes.TEXT, allowNull: true });
  await qi.addColumn("sources", "sync_interval_min", { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  await qi.addColumn("game_servers", "services_status", { type: DataTypes.JSON, allowNull: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("game_servers", "services_status");
  await qi.removeColumn("sources", "sync_interval_min");
  await qi.removeColumn("sources", "auth_token");
}
