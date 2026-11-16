/**
 * The installed game version of a server, which `settings` fields (`since`/`until`) and mod catalogs filter by. It
 * comes from the definition's `game_version` (or, without one, the older `settings.version` / `settings.version_file`):
 * the first line of `file` when it holds a version, else the rendered `value`. A value that isn't a version (`latest`)
 * is unknown (null).
 */
import type { GameDefinition, GameVersionSpec } from "@shared/protocol/protocol.gen.ts";
import { DefinitionEngine } from "../definitions/DefinitionEngine.ts";
import { GameSettings } from "../definitions/GameSettings.ts";
import type { GameServer, User } from "../models/index.ts";
import { FileService } from "./FileService.ts";

export namespace GameVersion {
  /**
   * Where the definition says the version comes from: `game_version`, else the settings' older keys; null when
   * neither names a source.
   */
  export function spec(def: GameDefinition): GameVersionSpec | null {
    if (def.game_version !== undefined) return def.game_version;
    const settings = def.settings;
    if (settings?.version === undefined && settings?.version_file === undefined) return null;
    return { value: settings.version, file: settings.version_file };
  }

  /**
   * The server's game version, or null when it isn't known. The file is read through the file API (the caller has
   * checked `manage` access); any read error (missing, binary, too large, host offline) falls back to `value`.
   * @param values The server's variable values, for `value`.
   */
  export async function of(user: User, server: GameServer, def: GameDefinition, values: Record<string, DefinitionEngine.Value>): Promise<string | null> {
    const source = spec(def);
    if (source === null) return null;
    if (source.file !== undefined) {
      const text = await FileService.read(user, server.id, source.file).then((res) => res.content, () => null);
      const line = text?.split(/\r?\n/, 1)[0].trim();
      if (line !== undefined && GameSettings.isVersion(line)) return line;
    }
    return fromValue(source, server, values);
  }

  /**
   * The rendered `value` when it is a version, else null (no value, an unknown placeholder, `latest`).
   */
  export function fromValue(source: GameVersionSpec, server: Pick<GameServer, "id" | "name">, values: Record<string, DefinitionEngine.Value>): string | null {
    if (source.value === undefined) return null;
    try {
      const rendered = DefinitionEngine.render(source.value, { vars: values, ports: {}, server: { id: server.id, name: server.name } }).trim();
      return GameSettings.isVersion(rendered) ? rendered : null;
    } catch {
      return null;
    }
  }
}

export default GameVersion;
