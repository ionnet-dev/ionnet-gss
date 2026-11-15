/**
 * M2 hardening: a server row stays as a tombstone in state `deleting` until its agent confirms the delete (a delete
 * that timed out, or a create rolled back while the host was slow or away), so reconcile never provisions it again
 * and its ports stay held until the container is gone. `delete_keep_data` is the delete's `keepData`.
 */
import { DataTypes, type QueryInterface } from "sequelize";

const STATES = ["creating", "installing", "install_failed", "stopped", "starting", "running", "stopping", "crashed"];

export async function up(qi: QueryInterface): Promise<void> {
  await qi.changeColumn("game_servers", "state", {
    type: DataTypes.ENUM(...STATES, "deleting"),
    allowNull: false,
    defaultValue: "creating",
  });
  await qi.addColumn("game_servers", "delete_keep_data", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.sequelize.query("UPDATE game_servers SET state = 'stopped' WHERE state = 'deleting'");
  await qi.removeColumn("game_servers", "delete_keep_data");
  await qi.changeColumn("game_servers", "state", {
    type: DataTypes.ENUM(...STATES),
    allowNull: false,
    defaultValue: "creating",
  });
}
