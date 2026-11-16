/**
 * The Game settings tab (`/api/servers/:id/game-settings`): the typed form built from a definition's `settings` block.
 * The game's own config file stays the source of truth. It is read through the file API (`FileService`, so access is
 * `manage` and the host must be online), the form shows what the file holds, and a save writes back only the changed
 * keys, leaving every other line as it is. Nothing goes into the agent's spec.
 *
 * Concurrent saves are made safe by the file's `modifiedAt` (409 when it changed since the form loaded), not by the
 * per-server operation lock: that lock is held for the whole of a start or install, and a settings save shouldn't wait
 * minutes behind one.
 */
import type {
  GameSettingDto,
  GameSettingsFileDto,
  GameSettingsGroupDto,
  GameSettingsResponse,
  UpdateGameSettingsBody,
} from "@shared/api/gameSettings.ts";
import type { GameDefinition, SettingField, SettingsFile } from "@shared/protocol/protocol.gen.ts";
import { DefinitionEngine } from "../definitions/DefinitionEngine.ts";
import { GameSettings } from "../definitions/GameSettings.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { GameServer, User } from "../models/index.ts";
import { FileService } from "./FileService.ts";
import { GameVersion } from "./GameVersion.ts";
import { ServerAccess } from "./ServerAccess.ts";

export namespace GameSettingsService {
  /**
   * Most keys one save may change in one file.
   */
  export const MAX_VALUES_PER_FILE = 1000;

  /**
   * What the tab shows for one server: its definition's settings, variable values and file contents.
   */
  interface Context {
    server: GameServer;
    settings: NonNullable<GameDefinition["settings"]>;
    values: Record<string, string | number | boolean>;
    version: string | null;
  }

  interface Loaded {
    file: SettingsFile;
    exists: boolean;
    modifiedAt: string | null;
    text: string;
    current: Map<string, string>;
    managed: Set<string>;
    hidden: Set<string>; // The file's `hide`: never listed, refused on save.
    applied: Map<string, GameSettings.AppliedField>;
  }

  /**
   * The form's state: every declared file with the fields that apply to the server's version and variables and the
   * values the file holds now.
   * @throws HttpError 404 without access or when the game has no game settings, 409 when the host is offline.
   */
  export async function get(user: User, serverId: string): Promise<GameSettingsResponse> {
    const context = await open(user, serverId);
    const files: GameSettingsFileDto[] = [];
    for (const file of context.settings.files) files.push(toDto(await load(user, context, file)));
    return { version: context.version, files };
  }

  /**
   * Write the changed keys. Every file and value is checked before the first file is written. Files whose text doesn't
   * change are skipped.
   * @throws HttpError 400 naming the file or `"Label" (key)`, 404, 409 when a file changed since it was loaded.
   */
  export async function update(user: User, serverId: string, body: Partial<UpdateGameSettingsBody>): Promise<GameSettingsResponse> {
    if (!Array.isArray(body.files) || body.files.length === 0) throw HttpError.badRequest("\"files\" must list the settings files to change.");
    const context = await open(user, serverId);
    const seen = new Set<string>();
    const writes: { path: string; text: string; modifiedAt: string | null }[] = [];
    for (const [i, change] of body.files.entries()) {
      const where = `files[${i}]`;
      if (change === null || typeof change !== "object" || typeof change.file !== "string") throw HttpError.badRequest(`"${where}.file" must name a settings file.`);
      const file = context.settings.files.find((candidate) => candidate.file === change.file);
      if (!file) throw HttpError.badRequest(`"${change.file}" isn't a settings file of this game. Known files: ${context.settings.files.map((f) => f.file).join(", ")}.`);
      if (seen.has(file.file)) throw HttpError.badRequest(`"${file.file}" is listed twice; send all its changes in one entry.`);
      seen.add(file.file);
      if (change.modifiedAt !== null && (typeof change.modifiedAt !== "string" || Number.isNaN(Date.parse(change.modifiedAt)))) {
        throw HttpError.badRequest(`"${where}.modifiedAt" must be the modifiedAt the file was loaded with, or null.`);
      }
      if (change.values === null || typeof change.values !== "object" || Array.isArray(change.values)) throw HttpError.badRequest(`"${where}.values" must map keys to their new text.`);
      const entries = Object.entries(change.values);
      if (entries.length > MAX_VALUES_PER_FILE) throw HttpError.badRequest(`At most ${MAX_VALUES_PER_FILE} keys can be changed at once in one file.`);

      const loaded = await load(user, context, file);
      {
        // null means the form was loaded before the file existed: the game may have written it since.
        const stale = change.modifiedAt === null ? loaded.exists : !loaded.exists || Date.parse(loaded.modifiedAt!) !== Date.parse(change.modifiedAt);
        if (stale) throw HttpError.conflict(`"${file.file}" changed since you opened the settings. Reload them and apply your changes again.`);
      }
      const set: Record<string, string> = {};
      for (const [key, value] of entries) set[key] = checkChange(loaded, key, value);
      const text = GameSettings.FORMATS[file.format]!.write(loaded.text, set);
      if (text === loaded.text) continue;
      writes.push({ path: file.file, text, modifiedAt: loaded.modifiedAt });
    }
    for (const write of writes) await FileService.write(user, serverId, write.path, write.text, write.modifiedAt);
    return await get(user, serverId);
  }

  /**
   * Whether a definition has a Game settings tab: a `settings` block with at least one file.
   */
  export function hasSettings(document: GameDefinition): boolean {
    return (document.settings?.files.length ?? 0) > 0;
  }

  /**
   * The checked text for one submitted key.
   */
  function checkChange(loaded: Loaded, key: string, value: unknown): string {
    if (loaded.managed.has(key)) throw HttpError.badRequest(`"${key}" in ${loaded.file.file} is set by the panel before every start, so it can't be changed here.`);
    if (loaded.hidden.has(key)) throw HttpError.badRequest(`"${key}" in ${loaded.file.file} can't be changed here. Edit the file in the Files tab if you really need it.`);
    const applied = loaded.applied.get(key);
    if (applied) return GameSettings.checkValue(applied.field, value);
    if (loaded.file.others === true && loaded.current.has(key)) return GameSettings.checkValue(otherField(key), value);
    throw HttpError.badRequest(`"${key}" isn't a setting of ${loaded.file.file} for this server's game version${loaded.file.others === true ? " and isn't in the file yet" : ""}.`);
  }

  async function open(user: User, serverId: string): Promise<Context> {
    const server = await ServerAccess.get(user, serverId, "manage", { include: [{ association: "definition" }] });
    const settings = server.definition?.document.settings;
    if (settings === undefined || !hasSettings(server.definition!.document)) throw HttpError.notFound("This server's game has no game settings.");
    const values = server.variables ?? {};
    return { server, settings, values, version: await GameVersion.of(user, server, server.definition!.document, values) };
  }

  /**
   * The file as text, or null when the agent says it doesn't exist (`not_found`). Access was checked before.
   */
  async function readIfExists(user: User, serverId: string, path: string): Promise<{ content: string; modifiedAt: string } | null> {
    try {
      const res = await FileService.read(user, serverId, path);
      return { content: res.content, modifiedAt: res.entry.modifiedAt };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async function load(user: User, context: Context, file: SettingsFile): Promise<Loaded> {
    const read = await readIfExists(user, context.server.id, file.file);
    const text = read?.content ?? "";
    const managed = new Set((context.server.definition!.document.configs ?? []).filter((config) => DefinitionEngine.normalPath(config.file) === file.file).flatMap((config) => Object.keys(config.set ?? {})));
    const hidden = new Set(file.hide ?? []);
    const applied = new Map(GameSettings.fieldsFor(file, context.values, context.version).filter(({ field }) => !managed.has(field.key)).map((entry) => [entry.field.key, entry]));
    return { file, exists: read !== null, modifiedAt: read?.modifiedAt ?? null, text, current: GameSettings.FORMATS[file.format]!.read(text), managed, hidden, applied };
  }

  function toDto(loaded: Loaded): GameSettingsFileDto {
    const groups: GameSettingsGroupDto[] = [];
    const byGroup = new Map<unknown, GameSettingsGroupDto>();
    for (const { group, field } of loaded.applied.values()) {
      let dto = byGroup.get(group);
      if (!dto) {
        dto = { name: group.name, description: group.description ?? null, fields: [] };
        byGroup.set(group, dto);
        groups.push(dto);
      }
      dto.fields.push(toFieldDto(field, loaded.current.get(field.key) ?? null));
    }
    if (loaded.file.others === true) {
      const fields = [...loaded.current.entries()]
        .filter(([key]) => !loaded.applied.has(key) && !loaded.managed.has(key) && !loaded.hidden.has(key))
        .map(([key, value]) => toFieldDto(otherField(key), value));
      if (fields.length > 0) groups.push({ name: "Other", description: "Keys in the file that the definition doesn't describe.", fields });
    }
    return {
      file: loaded.file.file,
      label: loaded.file.label ?? loaded.file.file,
      exists: loaded.exists,
      modifiedAt: loaded.modifiedAt,
      managed: [...loaded.managed],
      groups,
    };
  }

  function toFieldDto(field: SettingField, value: string | null): GameSettingDto {
    return {
      key: field.key,
      label: field.label ?? field.key,
      description: field.description ?? null,
      type: field.type,
      options: field.options ?? null,
      labels: field.labels ?? null,
      min: field.min ?? null,
      max: field.max ?? null,
      integer: field.integer ?? false,
      unit: field.unit ?? null,
      pattern: field.pattern ?? null,
      default: GameSettings.toText(field.default),
      value,
    };
  }

  /**
   * The stand-in for a key of the `others` group: plain text.
   */
  function otherField(key: string): SettingField {
    return { key, type: "string" };
  }
}

export default GameSettingsService;
