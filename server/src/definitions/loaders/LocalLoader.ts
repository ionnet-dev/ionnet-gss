import fsp from "node:fs/promises";
import Path from "node:path";
import type { Source } from "../../models/Source.ts";
import type { DefinitionLoader, LoadResult, RawDefinitionFolder } from "./DefinitionLoader.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_GAME = 200;
const MAX_DEPTH = 8;

/**
 * A folder on the panel (`source.url`, relative to the repo root; the built-in source uses GAMES_DIR). Commit is
 * always "local", so re-syncing an edited folder replaces the stored version in place (dev workflow).
 * Files over 1 MiB, symlinks, dotfiles and files that aren't UTF-8 text are skipped.
 */
export class LocalLoader implements DefinitionLoader {
  public async load(source: Source): Promise<LoadResult> {
    const root = Path.resolve(source.url, source.path);
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      throw new Error(`The definitions folder ${root} can't be read (${(error as Error).message}). Check GAMES_DIR or the source's folder.`);
    }

    const folders: RawDefinitionFolder[] = [];
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = Path.join(root, entry.name);
      const files = await LocalLoader.readFiles(dir);
      const gameYml = files["game.yml"];
      if (gameYml === undefined) continue; // Not a game folder.
      delete files["game.yml"];
      folders.push({ gameId: entry.name, gameYml, files });
    }
    return { commit: "local", folders };
  }

  /**
   * Every readable text file below `dir`, keyed by its path relative to `dir` (always with `/`).
   */
  private static async readFiles(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const walk = async (current: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new Error(`${dir} is nested deeper than ${MAX_DEPTH} folders.`);
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = Path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fsp.stat(path);
        if (stat.size > MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = decoder.decode(await fsp.readFile(path));
        } catch {
          continue; // Binary file.
        }
        if (Object.keys(files).length >= MAX_FILES_PER_GAME) throw new Error(`${dir} has more than ${MAX_FILES_PER_GAME} files.`);
        files[Path.relative(dir, path).split(Path.sep).join("/")] = text;
      }
    };
    await walk(dir, 0);
    return files;
  }
}

export default LocalLoader;
