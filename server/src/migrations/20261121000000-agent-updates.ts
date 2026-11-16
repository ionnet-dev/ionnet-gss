/**
 * M6: `hosts.auto_update_agent` opts a host in to updating its agent whenever it connects with an older build than
 * the panel serves. Off for every host until an admin turns it on.
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("hosts", "auto_update_agent", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("hosts", "auto_update_agent");
}
