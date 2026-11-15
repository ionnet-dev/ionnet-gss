import {
  type CreationOptional,
  DataTypes,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import { ID, jsonColumn } from "./columns.ts";

/**
 * A git repo of definitions that the panel syncs (M3). Only admins add sources (SOURCES_MANAGE): a definition is code.
 */
export class Source extends Model<InferAttributes<Source>, InferCreationAttributes<Source>> {
  declare id: CreationOptional<number>;
  declare name: string; // Unique slug, shown next to definitions (e.g. "ionnet-gss-games"; "builtin" for games/).
  declare kind: CreationOptional<Source.Kind>; // Picks the loader in definitions/loaders/.
  declare url: string; // git clone URL; for `local`, the folder (GAMES_DIR).
  declare branch: CreationOptional<string>; // Default "main".
  declare path: CreationOptional<string>; // Folder inside the repo holding one folder per game. "" = repo root.
  declare enabled: CreationOptional<boolean>;
  declare lastSyncAt: Date | null;
  declare lastCommit: string | null; // Commit of the last successful sync.
  declare lastError: string | null; // Sync-level failure (clone, fetch). null = last sync worked.
  declare definitionErrors: CreationOptional<Record<string, string>>; // gameId → validation error from the last sync.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Source.init({
      id: ID,
      name: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      kind: { type: DataTypes.ENUM(...Source.KINDS), allowNull: false, defaultValue: "git" },
      url: { type: DataTypes.STRING(512), allowNull: false },
      branch: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "main" },
      path: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      lastSyncAt: { type: DataTypes.DATE, allowNull: true },
      lastCommit: { type: DataTypes.STRING(64), allowNull: true },
      lastError: { type: DataTypes.TEXT, allowNull: true },
      definitionErrors: { ...jsonColumn("definitionErrors", false, {}), defaultValue: {} },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "sources" });
  }
}

export namespace Source {
  /**
   * local: a folder on the panel (the built-in `builtin` source = GAMES_DIR, commit = "local"); git: M3.
   */
  export const KINDS = ["local", "git"] as const;
  export type Kind = typeof KINDS[number];

  /**
   * Name of the built-in source created at startup from GAMES_DIR.
   */
  export const BUILTIN_NAME = "builtin";
}

export type SourceAttributes = InferAttributes<Source>;
export default Source;
