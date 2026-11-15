/**
 * Where definition folders come from. One implementation per `Source.kind`: `LocalLoader` (M2, a folder on the
 * panel) and `GitLoader` (M3, clone/fetch into AppSystem.sourcesDir). Loaders only read files; validation and storage
 * are `DefinitionSync`'s job.
 */
import type { Source } from "../../models/Source.ts";

/**
 * One game folder as read from a source.
 */
export interface RawDefinitionFolder {
  gameId: string; // Folder name.
  gameYml: string; // Contents of game.yml.
  files: Record<string, string>; // Every other file, by path relative to the folder (hooks/install.sh, templates).
}

export interface LoadResult {
  commit: string; // git commit, or "local" for folder sources.
  folders: RawDefinitionFolder[];
}

export interface DefinitionLoader {
  /**
   * Read every game folder of the source (one folder level below `source.path`, each with a game.yml).
   * @throws Error with a readable message when the source itself can't be read (missing folder, clone failed).
   */
  load(source: Source): Promise<LoadResult>;
}
