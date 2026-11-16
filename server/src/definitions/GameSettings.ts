/**
 * Game settings: the logic behind a definition's `settings` block (pure, no database, no agent). Version comparison,
 * which fields apply to a server, value checks, and the formats that read and write the game's own config files.
 * `DefinitionEngine` checks definitions with it, `GameSettingsService` serves the tab with it.
 */
import type { ConfigFormat, SettingField, SettingsFile, SettingsGroup } from "@shared/protocol/protocol.gen.ts";
import { whenHolds } from "@shared/variables.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Patterns } from "./patterns.ts";

export namespace GameSettings {
  /**
   * How the panel reads and edits one config file format. `read` returns the unescaped value of every key; `write`
   * assigns the keys of `set` and leaves everything else in the text as it was.
   */
  export interface SettingsFormat {
    read(text: string): Map<string, string>;
    write(text: string, set: Record<string, string>): string;
  }

  /**
   * A field that applies to a server, with the group it was declared in.
   */
  export interface AppliedField {
    group: SettingsGroup;
    field: SettingField;
  }

  /**
   * Most characters a `string` setting can have.
   */
  export const MAX_TEXT_CHARS = 1024;

  /**
   * Longest version text accepted from a `version_file`, in characters.
   */
  export const MAX_VERSION_CHARS = 64;

  const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*$/;
  const NUMBER_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;

  //#region Versions
  /**
   * Whether the text is a dotted numeric version (`1.21.4`, `26.1`, `5`).
   */
  export function isVersion(text: string): boolean {
    return text.length <= MAX_VERSION_CHARS && VERSION_PATTERN.test(text);
  }

  /**
   * The numeric segments of a version, or null when the text isn't one.
   */
  export function parseVersion(text: string): number[] | null {
    return isVersion(text) ? text.split(".").map(Number) : null;
  }

  /**
   * Negative when `a` is older than `b`, 0 when equal, positive when newer. Missing segments count as 0 (`1.21` equals
   * `1.21.0`), segments compare as numbers (`1.21.4` < `26.1`).
   * @throws Error when either text isn't a version.
   */
  export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (left === null || right === null) throw new Error(`"${left === null ? a : b}" isn't a version (dotted numbers like 1.21.4).`);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (left[i] ?? 0) - (right[i] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }
  //#endregion

  //#region Fields
  /**
   * Whether a field applies to a server: its `when` holds for the variable values, the version is at least `since`
   * (inclusive) and below `until` (exclusive). With an unknown version (null) the newest fields apply: `since` holds,
   * `until` doesn't.
   */
  export function applies(field: SettingField, values: Record<string, unknown>, version: string | null): boolean {
    if (!whenHolds(field.when, values)) return false;
    if (field.since !== undefined && version !== null && compareVersions(version, field.since) < 0) return false;
    if (field.until !== undefined && (version === null || compareVersions(version, field.until) >= 0)) return false;
    return true;
  }

  /**
   * The fields of a file that apply, in declaration order. A key declared more than once yields its first applicable
   * field.
   */
  export function fieldsFor(file: SettingsFile, values: Record<string, unknown>, version: string | null): AppliedField[] {
    const seen = new Set<string>();
    const result: AppliedField[] = [];
    for (const group of file.groups) {
      for (const field of group.fields) {
        if (seen.has(field.key) || !applies(field, values, version)) continue;
        seen.add(field.key);
        result.push({ group, field });
      }
    }
    return result;
  }

  /**
   * A default as file text (`true` → `"true"`, `20` → `"20"`); null when the field has none.
   */
  export function toText(value: string | number | boolean | undefined | null): string | null {
    return value === undefined || value === null ? null : String(value);
  }

  /**
   * Check a submitted value against its field and return it as the text to write (numbers trimmed).
   * @throws HttpError 400 naming the field as `"Label" (key)`.
   */
  export function checkValue(field: SettingField, text: unknown): string {
    const label = `"${field.label ?? field.key}" (${field.key})`;
    if (typeof text !== "string") throw HttpError.badRequest(`${label} must be text.`);
    const unit = field.unit ? ` ${field.unit}` : "";
    switch (field.type) {
      case "boolean":
        if (text !== "true" && text !== "false") throw HttpError.badRequest(`${label} must be true or false.`);
        return text;
      case "number": {
        const trimmed = text.trim();
        const number = NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : NaN;
        if (!Number.isFinite(number)) throw HttpError.badRequest(`${label} must be a number.`);
        // Java's Integer.parseInt refuses "20.0" and anything past int range; the game would silently use its default.
        if (field.integer && (!/^-?[0-9]{1,10}$/.test(trimmed) || Math.abs(number) > 2147483647)) throw HttpError.badRequest(`${label} must be a whole number.`);
        if (field.min !== undefined && number < field.min) throw HttpError.badRequest(`${label} must be at least ${field.min}${unit}.`);
        if (field.max !== undefined && number > field.max) throw HttpError.badRequest(`${label} can be at most ${field.max}${unit}.`);
        return trimmed;
      }
      case "select":
        if (!(field.options ?? []).includes(text)) throw HttpError.badRequest(`${label} must be one of: ${(field.options ?? []).join(", ")}.`);
        return text;
      default: // string
        // Length first: the pattern runs on a backtracking engine.
        if (text.length > MAX_TEXT_CHARS) throw HttpError.badRequest(`${label} can be at most ${MAX_TEXT_CHARS} characters long.`);
        if (/[\r\n\0]/.test(text)) throw HttpError.badRequest(`${label} can't contain line breaks.`);
        if (field.pattern !== undefined && !Patterns.matchesWhole(field.pattern, text)) {
          throw HttpError.badRequest(`${label} isn't in the expected format (${field.pattern}).`);
        }
        return text;
    }
  }
  //#endregion

  //#region Properties
  /**
   * Java `.properties`, mirroring the agent's `configs/properties.go` (which applies `configs.set` to the same file):
   * lines the edit doesn't touch stay byte-identical, CRLF is kept, comments (`#`, `!`) and continuation lines are
   * understood, keys and values are escaped like `Properties.store` (`\:`, `\=`, `\uXXXX` for non-ASCII, because
   * Minecraft loads the file as ISO-8859-1), and missing keys are appended in key order.
   */
  const properties: SettingsFormat = {
    read(text) {
      const result = new Map<string, string>();
      const { physical } = splitLines(text);
      for (let i = 0; i < physical.length; i++) {
        const line = physical[i];
        const trimmed = line.replace(/^[ \t\f]+/, "");
        if (trimmed === "" || trimmed[0] === "#" || trimmed[0] === "!") continue;
        let logical = trimmed;
        let end = i;
        while (end < physical.length - 1 && continues(physical[end])) {
          end++;
          logical = `${logical.slice(0, -1)}${physical[end].replace(/^[ \t\f]+/, "")}`;
        }
        if (end === physical.length - 1 && continues(physical[end])) logical = logical.slice(0, -1);
        i = end;
        const [key, value] = splitLogical(logical);
        result.set(key, value);
      }
      return result;
    },

    write(text, set) {
      if (Object.keys(set).length === 0) return text;
      const { physical, eol } = splitLines(text);
      const seen = new Set<string>();
      const out: string[] = [];
      for (let i = 0; i < physical.length; i++) {
        const line = physical[i];
        const trimmed = line.replace(/^[ \t\f]+/, "");
        if (trimmed === "" || trimmed[0] === "#" || trimmed[0] === "!") {
          out.push(line);
          continue;
        }
        // A logical line continues while a physical line ends in an odd number of backslashes.
        let end = i;
        while (end < physical.length - 1 && continues(physical[end])) end++;
        const key = propertyKey(trimmed);
        if (Object.hasOwn(set, key)) {
          out.push(`${escapeProperty(key, true)}=${escapeProperty(set[key], false)}`);
          seen.add(key);
        }
        else {
          out.push(...physical.slice(i, end + 1));
        }
        i = end;
      }
      for (const key of Object.keys(set).filter((key) => !seen.has(key)).sort()) {
        out.push(`${escapeProperty(key, true)}=${escapeProperty(set[key], false)}`);
      }
      return out.length === 0 ? "" : out.join(eol) + eol;
    },
  };

  /**
   * The lines of a text without their line endings, and the ending to write new lines with (CRLF when the text has
   * any). A trailing line ending doesn't make an empty last line.
   */
  function splitLines(text: string): { physical: string[]; eol: string } {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    if (text === "") return { physical: [], eol };
    const physical = text.replaceAll("\r\n", "\n").split("\n");
    if (text.endsWith("\n")) physical.pop();
    return { physical, eol };
  }

  /**
   * Whether the line ends in an odd number of backslashes (the logical line goes on).
   */
  function continues(line: string): boolean {
    let count = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) count++;
    return count % 2 === 1;
  }

  /**
   * The (unescaped) key at the start of a trimmed logical line, and the index where it ends: at the first unescaped
   * `=`, `:` or whitespace.
   */
  function readKey(line: string): { key: string; end: number } {
    let key = "";
    let i = 0;
    for (; i < line.length; i++) {
      const char = line[i];
      if (char === "=" || char === ":" || char === " " || char === "\t" || char === "\f") break;
      if (char !== "\\" || i === line.length - 1) {
        key += char;
        continue;
      }
      i++;
      const [text, skip] = unescapeAt(line, i);
      key += text;
      i += skip;
    }
    return { key, end: i };
  }

  function propertyKey(line: string): string {
    return readKey(line).key;
  }

  /**
   * One escape sequence: `i` is the character after the backslash. Returns the text it stands for and how many more
   * characters it used.
   */
  function unescapeAt(line: string, i: number): [string, number] {
    switch (line[i]) {
      case "t": return ["\t", 0];
      case "n": return ["\n", 0];
      case "r": return ["\r", 0];
      case "f": return ["\f", 0];
      case "u": {
        const hex = line.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 4];
        return ["u", 0];
      }
      default: return [line[i], 0];
    }
  }

  /**
   * Key and value of one trimmed logical line (continuations already joined): the value starts after the key, any
   * whitespace and one `=` or `:`, and is unescaped.
   */
  function splitLogical(line: string): [string, string] {
    const { key, end } = readKey(line);
    let i = end;
    while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === "\f")) i++;
    if (line[i] === "=" || line[i] === ":") i++;
    while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === "\f")) i++;
    let value = "";
    for (; i < line.length; i++) {
      if (line[i] !== "\\" || i === line.length - 1) {
        value += line[i];
        continue;
      }
      i++;
      const [text, skip] = unescapeAt(line, i);
      value += text;
      i += skip;
    }
    return [key, value];
  }

  /**
   * Escape like `Properties.saveConvert`: keys escape every space, values only a leading one.
   */
  function escapeProperty(text: string, isKey: boolean): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      switch (char) {
        case " ":
          out += isKey || i === 0 ? "\\ " : " ";
          break;
        case "\\": out += "\\\\"; break;
        case "\t": out += "\\t"; break;
        case "\n": out += "\\n"; break;
        case "\r": out += "\\r"; break;
        case "\f": out += "\\f"; break;
        case "=":
        case ":":
        case "#":
        case "!":
          out += `\\${char}`;
          break;
        default: {
          const code = char.charCodeAt(0);
          out += code < 0x20 || code > 0x7e ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}` : char;
        }
      }
    }
    return out;
  }
  //#endregion

  /**
   * The formats the Game settings tab can edit, by `ConfigFormat`. Definitions naming another format are refused.
   */
  export const FORMATS: Partial<Record<ConfigFormat, SettingsFormat>> = {
    properties,
  };
}

export default GameSettings;
