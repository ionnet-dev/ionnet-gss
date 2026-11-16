/**
 * `/api/servers/:id/game-settings`: the Game settings tab, built from the definition's `settings` block. Access:
 * `manage` (like files); 404 otherwise, and 404 when the definition has no `settings`. The panel reads and writes the
 * config files through the agent's file API, so the host must be online (409). Values travel as the text the file
 * holds (`"true"`, `"20"`, `"minecraft:normal"`), already unescaped from the file format.
 */
import type { IsoDate } from "./common.ts";
import type { SettingType } from "../protocol/protocol.gen.ts";

/**
 * `GET /api/servers/:id/game-settings`.
 */
export interface GameSettingsResponse {
  /**
   * The game version the fields were picked for (`version_file`, else the rendered `version`); null when unknown
   * (e.g. `latest` before the first install): then the newest fields apply.
   */
  version: string | null;
  files: GameSettingsFileDto[];
}

export interface GameSettingsFileDto {
  file: string; // Path below the data folder, e.g. "server.properties".
  label: string; // Section title (the file name when the definition has none).
  /**
   * False before the game wrote it: every field shows its default, and saving creates the file with the changed keys.
   */
  exists: boolean;
  /**
   * The file's `modifiedAt` when it was read; send it back in `UpdateGameSettingsBody` (409 when the file changed
   * since). Null when it doesn't exist.
   */
  modifiedAt: IsoDate | null;
  /**
   * Keys the panel sets itself before every start (the definition's `configs.set` for this file, e.g. `server-port`).
   * Never listed as fields and refused on save. The file's `hide` keys are refused too, and not reported.
   */
  managed: string[];
  /**
   * The declared groups with the fields that apply to this server (its variables and version), in declaration order;
   * empty groups are left out. With `others`, a last group "Other" holds the file's undeclared keys as `string` fields.
   */
  groups: GameSettingsGroupDto[];
}

export interface GameSettingsGroupDto {
  name: string;
  description: string | null;
  fields: GameSettingDto[];
}

export interface GameSettingDto {
  key: string;
  label: string; // The key itself when the definition has no label.
  description: string | null;
  type: SettingType;
  options: string[] | null; // `select` only.
  labels: Record<string, string> | null; // `select` only: display text by option value.
  min: number | null;
  max: number | null;
  integer: boolean;
  unit: string | null;
  pattern: string | null;
  default: string | null; // As file text ("true", "20"); null when the definition has none.
  value: string | null; // In the file now; null = missing (the game uses `default`).
}

/**
 * `PUT /api/servers/:id/game-settings`: only the keys that changed. Each value is checked against its field (type,
 * options, min/max/integer, pattern; 400 naming it as `"Label" (key)`); keys of `managed` or of no applicable field
 * are refused (400), except undeclared keys already in a file with `others`. Lines and comments the request doesn't
 * touch stay as they are; missing keys are appended. Changes apply at the game's next start.
 */
export interface UpdateGameSettingsBody {
  files: {
    file: string;
    modifiedAt: IsoDate | null; // From `GameSettingsFileDto`; null = the file didn't exist (409 when it does now).
    values: Record<string, string>;
  }[];
}

/**
 * The fresh state after the write.
 */
export type UpdateGameSettingsResponse = GameSettingsResponse;
