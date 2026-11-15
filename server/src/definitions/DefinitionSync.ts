/**
 * Sync a source into `definitions` rows: load (per kind) → `DefinitionEngine.parse` each game.yml →
 * `resolve` extends within the source → upsert one row per (source, gameId, commit) and make it `active`.
 * A game that fails validation keeps its previous active row; its error goes to `source.definitionErrors`.
 * Games that disappeared from the source are deactivated (servers keep the version they are pinned to).
 */
import { Op } from "sequelize";
import type { GameDefinition } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { Definition, sequelize, Source } from "../models/index.ts";
import { DefinitionEngine } from "./DefinitionEngine.ts";
import type { LoadResult } from "./loaders/DefinitionLoader.ts";
import { LOADERS } from "./loaders/index.ts";

export namespace DefinitionSync {
  export interface Result {
    synced: string[]; // gameIds now active at this commit.
    failed: Record<string, string>; // gameId → error.
  }

  /**
   * Create the built-in `local` source for GAMES_DIR if missing, then sync it. Called once from index.ts at startup;
   * never throws (logs instead), so a broken game.yml can't stop the panel.
   */
  export async function syncBuiltin(): Promise<void> {
    try {
      let source = await Source.findOne({ where: { name: Source.BUILTIN_NAME } });
      if (!source) {
        source = await Source.create({ name: Source.BUILTIN_NAME, kind: "local", url: Config.GAMES_DIR, lastSyncAt: null, lastCommit: null, lastError: null });
      }
      else if (source.kind !== "local" || source.url !== Config.GAMES_DIR) {
        source.kind = "local";
        source.url = Config.GAMES_DIR;
        await source.save();
      }
      const result = await syncSource(source);
      console.log(`definitions: ${result.synced.length} active (${result.synced.join(", ") || "none"})`);
      for (const [gameId, error] of Object.entries(result.failed)) console.error(`definitions: ${gameId} was skipped: ${error}`);
    } catch (error) {
      console.error(`definitions: the built-in source could not be synced: ${(error as Error).message}`);
    }
  }

  /**
   * Load the source, validate every game and store the valid ones. Per-game problems are returned (and stored in
   * `source.definitionErrors`), not thrown.
   * @throws Error when the source itself can't be read; the message is stored in `source.lastError` first.
   */
  export async function syncSource(source: Source): Promise<Result> {
    const loader = LOADERS[source.kind as Source.Kind];
    if (!loader) {
      const message = `Sources of kind "${source.kind}" can't be synced by this panel version yet.`;
      await recordFailure(source, message);
      throw new Error(message);
    }
    let loaded: LoadResult;
    try {
      loaded = await loader.load(source);
    } catch (error) {
      await recordFailure(source, (error as Error).message);
      throw error;
    }

    const failed: Record<string, string> = {};
    const parsed = new Map<string, GameDefinition>();
    for (const folder of loaded.folders) {
      try {
        const def = DefinitionEngine.parse(folder.gameYml, `${folder.gameId}/game.yml`);
        if (def.id !== folder.gameId) throw new Error(`${folder.gameId}/game.yml: "id" is "${def.id}" but the folder is named "${folder.gameId}". They must match.`);
        parsed.set(def.id, def);
      } catch (error) {
        failed[folder.gameId] = (error as Error).message;
      }
    }

    const valid: { gameId: string; document: GameDefinition; files: Record<string, string> }[] = [];
    for (const folder of loaded.folders) {
      if (!parsed.has(folder.gameId)) continue;
      try {
        const document = DefinitionEngine.resolve(parsed, folder.gameId);
        for (const path of DefinitionEngine.referencedFiles(document)) {
          if (!Object.hasOwn(folder.files, path)) throw new Error(`${folder.gameId}/game.yml: the file "${path}" is referenced but not in the folder.`);
        }
        valid.push({ gameId: folder.gameId, document, files: folder.files });
      } catch (error) {
        failed[folder.gameId] = (error as Error).message;
      }
    }

    await sequelize.transaction(async (transaction) => {
      for (const { gameId, document, files } of valid) {
        const [row] = await Definition.findOrCreate({
          where: { sourceId: source.id, gameId, commit: loaded.commit },
          defaults: { sourceId: source.id, gameId, commit: loaded.commit, name: document.name ?? gameId, document, files, active: true },
          transaction,
        });
        row.name = document.name ?? gameId;
        row.document = document;
        row.files = files;
        row.active = true;
        row.changed("document", true);
        row.changed("files", true);
        await row.save({ transaction });
        await Definition.update({ active: false }, { where: { sourceId: source.id, gameId, id: { [Op.ne]: row.id } }, transaction });
      }
      // Gone from the source (and not merely broken): no new servers from it.
      const present = new Set(loaded.folders.map((folder) => folder.gameId));
      const active = await Definition.findAll({ where: { sourceId: source.id, active: true }, attributes: ["id", "gameId"], transaction });
      const goneIds = active.filter((row) => !present.has(row.gameId)).map((row) => row.id);
      if (goneIds.length) await Definition.update({ active: false }, { where: { id: goneIds }, transaction });

      source.lastSyncAt = new Date();
      source.lastCommit = loaded.commit;
      source.lastError = null;
      source.definitionErrors = failed;
      await source.save({ transaction });
    });

    return { synced: valid.map((v) => v.gameId), failed };
  }

  async function recordFailure(source: Source, message: string): Promise<void> {
    source.lastError = message;
    source.lastSyncAt = new Date();
    await source.save().catch((error) => console.error("could not store the source's sync error", error));
  }
}

export default DefinitionSync;
