/**
 * Egress filtering: `allow_private_network` lets a server's containers reach private, link-local and host
 * addresses. Every existing server starts restricted (false), like new ones; an admin opts a server out.
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("game_servers", "allow_private_network", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("game_servers", "allow_private_network");
}
