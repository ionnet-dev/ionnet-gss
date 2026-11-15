/**
 * M2: sources get a `kind` (the built-in `local` source is the repo's games/ folder; `git` sources are M3).
 */
import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("sources", "kind", {
    type: DataTypes.ENUM("local", "git"),
    allowNull: false,
    defaultValue: "git",
  });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("sources", "kind");
}
