import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
} from "sequelize";
import type { GameDefinition } from "@shared/protocol/protocol.gen.ts";
import { ID, intFk, jsonColumn } from "./columns.ts";
import type { Source } from "./Source.ts";

/**
 * One valid version of a game definition: a (source, game id, commit) triple. Servers pin the row they were created
 * from, so a later sync never changes a running server. Only valid versions are stored; validation errors go to
 * `Source.definitionErrors`. M2 seeds rows from the repo's own `games/` folder; M3 adds git sync.
 */
export class Definition extends Model<InferAttributes<Definition>, InferCreationAttributes<Definition>> {
  declare id: CreationOptional<number>;
  declare sourceId: ForeignKey<Source["id"]>;
  declare gameId: string; // Slug from game.yml `id`, e.g. "minecraft-java".
  declare name: string;
  declare commit: string;
  declare document: GameDefinition; // Parsed game.yml with `extends` already merged.
  declare files: Record<string, string>; // Path in the definition folder → content (hooks, templates).
  declare active: CreationOptional<boolean>; // The version new servers get. One active row per (source, game).
  declare createdAt: CreationOptional<Date>; // = synced at
  declare updatedAt: CreationOptional<Date>;

  declare source?: NonAttribute<Source>;

  public static initModel(sequelize: Sequelize): void {
    Definition.init({
      id: ID,
      sourceId: intFk(false),
      gameId: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(128), allowNull: false },
      commit: { type: DataTypes.STRING(64), allowNull: false },
      document: jsonColumn("document", false, {}),
      files: jsonColumn("files", false, {}),
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, {
      sequelize,
      tableName: "definitions",
      indexes: [{ unique: true, fields: ["source_id", "game_id", "commit"] }],
    });
  }
}

export type DefinitionAttributes = InferAttributes<Definition>;
export default Definition;
