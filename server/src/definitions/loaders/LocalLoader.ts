import { HttpError } from "../../lib/HttpError.ts";
import type { Source } from "../../models/Source.ts";
import type { DefinitionLoader, LoadResult } from "./DefinitionLoader.ts";

/**
 * A folder on the panel (`source.url`, relative to the repo root; the built-in source uses GAMES_DIR). Commit is
 * always "local", so re-syncing an edited folder replaces the stored version in place (dev workflow).
 * Files over 1 MiB, symlinks and dotfiles are skipped.
 */
export class LocalLoader implements DefinitionLoader {
  public async load(source: Source): Promise<LoadResult> {
    throw HttpError.notImplemented("LocalLoader.load"); // TODO(builder): C
  }
}

export default LocalLoader;
