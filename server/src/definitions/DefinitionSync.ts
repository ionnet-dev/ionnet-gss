/**
 * Sync a source into `definitions` rows: load (per kind) → `DefinitionEngine.parse` each game.yml →
 * `resolve` extends within the source → upsert one row per (source, gameId, commit) and make it `active`.
 * A game that fails validation keeps its previous active row; its error goes to `source.definitionErrors`.
 */
import { HttpError } from "../lib/HttpError.ts";
import type { Source } from "../models/Source.ts";

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
    // TODO(builder): C
  }

  export async function syncSource(source: Source): Promise<Result> {
    throw HttpError.notImplemented("DefinitionSync.syncSource"); // TODO(builder): C
  }
}

export default DefinitionSync;
