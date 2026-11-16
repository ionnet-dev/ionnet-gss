/**
 * Sync a source into `definitions` rows: load (per kind) → `DefinitionEngine.parse` each game.yml →
 * `resolve` extends within the source → upsert one row per (source, gameId, commit) and make it `active`.
 * A game that fails validation keeps its previous active row; its error goes to `source.definitionErrors`.
 * Games that disappeared from the source are deactivated (servers keep the version they are pinned to). A game whose
 * files didn't change since the active version keeps that version (no new row, so no "update available").
 * One sync at a time per source; listeners (`onChange`) hear when one starts and ends.
 */
import fsp from "node:fs/promises";
import Path from "node:path";
import { Op } from "sequelize";
import type { GameDefinition } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Definition, sequelize, Source } from "../models/index.ts";
import { DefinitionEngine } from "./DefinitionEngine.ts";
import type { LoadResult } from "./loaders/DefinitionLoader.ts";
import { LOADERS } from "./loaders/index.ts";

export namespace DefinitionSync {
  export interface Result {
    synced: string[]; // gameIds now active at this commit.
    failed: Record<string, string>; // gameId → error.
    changed: boolean; // Active definitions were added, replaced or deactivated.
  }

  /**
   * What `onChange` listeners get: a sync of the source started (`syncing`) or ended.
   */
  export interface Change {
    sourceId: number;
    syncing: boolean;
    definitionsChanged: boolean; // Only set when a sync ended and changed the active definitions.
  }

  const _running = new Set<number>();
  /**
   * Sources to sync again when their running sync ends (their address changed while it ran).
   */
  const _queued = new Set<number>();
  const _listeners: ((change: Change) => void)[] = [];

  /**
   * Hear about syncs (the controllers push `source.updated` / `definitions.updated` from it; definitions never talk to
   * browsers themselves).
   */
  export function onChange(listener: (change: Change) => void): void {
    _listeners.push(listener);
  }

  /**
   * Whether a sync of this source is running now.
   */
  export function isSyncing(sourceId: number): boolean {
    return _running.has(sourceId);
  }

  /**
   * Sync `source` in the background now, or right after the sync that is running (it read the old address or token).
   * Failures are stored on the source.
   */
  export function resyncSoon(source: Source): void {
    if (_running.has(source.id)) {
      _queued.add(source.id);
      return;
    }
    syncSource(source).catch((error) => console.warn(`sources: the sync of "${source.name}" failed: ${(error as Error).message}`));
  }

  function emit(change: Change): void {
    for (const listener of _listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("definitions: a sync listener failed", error);
      }
    }
  }

  /**
   * Create the built-in `local` source for GAMES_DIR if missing, then sync it. Without that folder (the Docker
   * image doesn't carry one) the official git source is added instead, see `seedOfficial`. Called once from
   * index.ts at startup; never throws (logs instead), so a broken game.yml can't stop the panel.
   */
  export async function syncBuiltin(): Promise<void> {
    try {
      let source = await Source.findOne({ where: { name: Source.BUILTIN_NAME } });
      const hasFolder = await fsp.stat(Path.resolve(Config.GAMES_DIR)).then((stat) => stat.isDirectory()).catch(() => false);
      if (!hasFolder) {
        // A built-in source that never held a game is only a leftover "sync failed" card.
        if (source && await Definition.count({ where: { sourceId: source.id } }) === 0) {
          await source.destroy();
          source = null;
        }
        await seedOfficial();
        if (!source) return;
      }
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
   * Add the official definitions repository (`OFFICIAL_SOURCE_URL`) as a git source and sync it in the background.
   * Only on a panel that has no git source yet, so one an admin removed comes back only when no other was added;
   * disable it instead to keep it away.
   */
  async function seedOfficial(): Promise<void> {
    if (Config.OFFICIAL_SOURCE_URL === "") return;
    if (await Source.count({ where: { kind: "git" } }) > 0) return;
    const source = await Source.create({
      name: Source.OFFICIAL_NAME,
      kind: "git",
      url: Config.OFFICIAL_SOURCE_URL,
      branch: "main",
      path: "",
      lastSyncAt: null,
      lastCommit: null,
      lastError: null,
      authToken: null,
      syncIntervalMin: null,
    });
    console.log(`definitions: added the official source ${source.url}`);
    resyncSoon(source);
  }

  /**
   * Load the source, validate every game and store the valid ones. Per-game problems are returned (and stored in
   * `source.definitionErrors`), not thrown.
   * @throws HttpError 409 while a sync of this source already runs.
   * @throws Error when the source itself can't be read; the message is stored in `source.lastError` first.
   */
  export async function syncSource(source: Source): Promise<Result> {
    if (_running.has(source.id)) throw HttpError.conflict("This source is already being synced. Wait for it to finish.");
    _running.add(source.id);
    emit({ sourceId: source.id, syncing: true, definitionsChanged: false });
    let changed = false;
    try {
      const result = await run(source);
      changed = result.changed;
      return result;
    } finally {
      _running.delete(source.id);
      emit({ sourceId: source.id, syncing: false, definitionsChanged: changed });
      if (_queued.delete(source.id)) {
        Source.findByPk(source.id)
          .then((fresh) => { if (fresh && fresh.enabled) resyncSoon(fresh); })
          .catch((error) => console.warn(`sources: the queued sync of source ${source.id} failed: ${(error as Error).message}`));
      }
    }
  }

  async function run(source: Source): Promise<Result> {
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

    const failed: Record<string, string> = { ...loaded.errors };
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

    let changed = false;
    await sequelize.transaction(async (transaction) => {
      for (const { gameId, document, files } of valid) {
        const name = document.name ?? gameId;
        const sameCommit = await Definition.findOne({ where: { sourceId: source.id, gameId, commit: loaded.commit }, transaction });
        const current = await Definition.findOne({ where: { sourceId: source.id, gameId, active: true }, transaction });
        if (!sameCommit && current && current.name === name && fingerprint(current.document, current.files) === fingerprint(document, files)) continue; // Nothing changed in this game's folder.
        let row = sameCommit;
        if (!row) {
          row = await Definition.create({ sourceId: source.id, gameId, commit: loaded.commit, name, document, files, active: true }, { transaction });
          changed = true;
        }
        else if (!row.active || row.name !== name || fingerprint(row.document, row.files) !== fingerprint(document, files)) {
          changed = true;
        }
        row.name = name;
        row.document = document;
        row.files = files;
        row.active = true;
        row.changed("document", true);
        row.changed("files", true);
        await row.save({ transaction });
        await Definition.update({ active: false }, { where: { sourceId: source.id, gameId, id: { [Op.ne]: row.id } }, transaction });
      }
      // Gone from the source (and not merely broken): no new servers from it.
      const present = new Set([...loaded.folders.map((folder) => folder.gameId), ...Object.keys(loaded.errors ?? {})]);
      const active = await Definition.findAll({ where: { sourceId: source.id, active: true }, attributes: ["id", "gameId"], transaction });
      const goneIds = active.filter((row) => !present.has(row.gameId)).map((row) => row.id);
      if (goneIds.length) {
        await Definition.update({ active: false }, { where: { id: goneIds }, transaction });
        changed = true;
      }

      source.lastSyncAt = new Date();
      source.lastCommit = loaded.commit;
      source.lastError = null;
      source.definitionErrors = failed;
      await source.save({ transaction });
    });

    return { synced: valid.map((v) => v.gameId), failed, changed };
  }

  function fingerprint(document: unknown, files: Record<string, string>): string {
    return DefinitionEngine.canonicalJson({ document, files });
  }

  async function recordFailure(source: Source, message: string): Promise<void> {
    source.lastError = message;
    source.lastSyncAt = new Date();
    await source.save().catch((error) => console.error("could not store the source's sync error", error));
  }
}

export default DefinitionSync;
