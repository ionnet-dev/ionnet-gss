import {
  type CreationOptional,
  DataTypes,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import type { MailSecurity, UpdateMailSettingsBody } from "@shared/api/settings.ts";
import { HttpError } from "../lib/HttpError.ts";
import { User } from "./User.ts";

const MAIL_SECURITY: readonly MailSecurity[] = ["tls", "starttls", "none"];

/**
 * A panel setting edited in the UI (M7): one row per key, the value as JSON text. Read through `Setting.get`, which
 * caches every key in memory (one panel process, so the cache can't drift from another writer).
 */
export class Setting extends Model<InferAttributes<Setting>, InferCreationAttributes<Setting>> {
  declare key: string; // A `Setting.Key`.
  declare value: string; // JSON.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Setting.init({
      key: { type: DataTypes.STRING(64), primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "settings" });
  }

  //#region Cache
  /**
   * What each key holds while no row exists.
   */
  public static readonly DEFAULTS: Readonly<Setting.Values> = Object.freeze({
    mail: Object.freeze({
      enabled: false,
      host: "",
      port: 587,
      security: "starttls",
      username: null,
      passwordBox: null,
      fromAddress: "",
      fromName: null,
      verifyCertificate: true,
      requireConfirmedEmail: false,
    }),
    catalogs: Object.freeze({
      curseforgeKeyBox: null,
    }),
  });

  private static _cache: Map<Setting.Key, Setting.CacheEntry> | null = null;
  private static _loading: Promise<void> | null = null;

  /**
   * Read every row into the cache. Called once at startup (after migrations), so `get()` and `Mailer.isEnabled()`
   * can be synchronous. Calling it again re-reads the table.
   */
  public static load(): Promise<void> {
    Setting._loading ??= (async () => {
      const cache = new Map<Setting.Key, Setting.CacheEntry>();
      for (const row of await Setting.findAll()) {
        if (!(row.key in Setting.DEFAULTS)) continue; // A key from a newer panel version.
        const key = row.key as Setting.Key;
        cache.set(key, { value: Setting._parse(key, row.value), updatedAt: row.updatedAt });
      }
      Setting._cache = cache;
    })().finally(() => Setting._loading = null);
    return Setting._loading;
  }

  /**
   * Whether `load()` has run.
   */
  public static isLoaded(): boolean {
    return Setting._cache !== null;
  }

  /**
   * The value of `key` (a copy: changing it changes nothing), or its default while no row exists.
   * @throws Error when `load()` hasn't run yet.
   */
  public static get<K extends Setting.Key>(key: K): Setting.Values[K] {
    const entry = Setting._requireCache().get(key);
    return structuredClone((entry?.value ?? Setting.DEFAULTS[key]) as Setting.Values[K]);
  }

  /**
   * When `key` was last saved, or null when it never was.
   * @throws Error when `load()` hasn't run yet.
   */
  public static updatedAt(key: Setting.Key): Date | null {
    return Setting._requireCache().get(key)?.updatedAt ?? null;
  }

  /**
   * Save `value` under `key` (insert or replace) and update the cache.
   */
  public static async set<K extends Setting.Key>(key: K, value: Setting.Values[K]): Promise<void> {
    const cache = Setting._requireCache();
    const json = JSON.stringify(value);
    await Setting.upsert({ key, value: json });
    const row = await Setting.findByPk(key);
    cache.set(key, { value: JSON.parse(json), updatedAt: row?.updatedAt ?? new Date() });
  }

  private static _requireCache(): Map<Setting.Key, Setting.CacheEntry> {
    if (!Setting._cache) throw new Error("Settings aren't loaded yet. Call `await Setting.load()` at startup, after the migrations.");
    return Setting._cache;
  }

  /**
   * A stored JSON value over the key's defaults, so a field added later gets its default. Unreadable JSON logs and
   * falls back to the defaults.
   */
  private static _parse<K extends Setting.Key>(key: K, json: string): Setting.Values[K] {
    try {
      const value = JSON.parse(json);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      return { ...Setting.DEFAULTS[key], ...value };
    } catch (error) {
      console.error(`setting "${key}" holds unreadable JSON (${(error as Error).message}); using the defaults`);
      return structuredClone(Setting.DEFAULTS[key]) as Setting.Values[K];
    }
  }
  //#endregion

  //#region Mail
  /**
   * Validate `body` (an `UpdateMailSettingsBody` from a request) and merge it over `current`. The password is only
   * validated here: sealing it is the caller's job (`draft.password`). When a password is stored and `host`, `port`,
   * `security` or `username` change without a new `password`, a save is refused and a test goes without the password.
   * @param mode `save`: the rules for storing (`enabled` needs a host and a sender, `requireConfirmedEmail` needs
   * `enabled`). `test`: a one-off send, which needs a host and a sender whatever `enabled` says.
   * @throws HttpError 400 naming the field that's wrong.
   */
  public static mergeMail(current: Setting.StoredMail, body: unknown, mode: "save" | "test"): Setting.MailDraft {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw HttpError.badRequest("The mail settings must be a JSON object.");
    const input = body as Record<keyof UpdateMailSettingsBody, unknown>;
    const mail: Setting.StoredMail = { ...current };
    const changes: string[] = [];
    const change = <F extends Exclude<keyof Setting.StoredMail, "passwordBox">>(field: F, value: Setting.StoredMail[F]) => {
      if (mail[field] !== value) changes.push(field);
      mail[field] = value;
    };

    for (const field of ["enabled", "verifyCertificate", "requireConfirmedEmail"] as const) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== "boolean") throw HttpError.badRequest(`${field} must be true or false.`);
      change(field, input[field]);
    }
    if (input.host !== undefined) {
      const host = typeof input.host === "string" ? input.host.trim() : null;
      if (host === null || host.length < 1 || host.length > 255 || /\s/.test(host)) {
        throw HttpError.badRequest("host must be a server name or IP address of 1 to 255 characters, without spaces.");
      }
      change("host", host);
    }
    if (input.port !== undefined) {
      if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        throw HttpError.badRequest("port must be a whole number from 1 to 65535.");
      }
      change("port", input.port);
    }
    if (input.security !== undefined) {
      if (!MAIL_SECURITY.includes(input.security as MailSecurity)) throw HttpError.badRequest(`security must be one of ${MAIL_SECURITY.join(", ")}.`);
      change("security", input.security as MailSecurity);
    }
    if (input.username !== undefined) {
      change("username", Setting._optionalText("username", input.username, 255));
    }
    if (input.fromAddress !== undefined) {
      let address: string | null;
      try {
        address = User.normalizeEmail(input.fromAddress);
      } catch (error) {
        throw HttpError.badRequest(`fromAddress: ${(error as Error).message}`);
      }
      change("fromAddress", address ?? "");
    }
    if (input.fromName !== undefined) {
      change("fromName", Setting._optionalText("fromName", input.fromName, 64));
    }

    let password: string | null | undefined;
    if (input.password !== undefined) {
      if (input.password !== null && typeof input.password !== "string") throw HttpError.badRequest("password must be a string or null.");
      if (typeof input.password === "string" && input.password.length > 255) throw HttpError.badRequest("password must be at most 255 characters.");
      password = input.password === "" ? null : input.password;
      if (password !== null || current.passwordBox !== null) changes.push("password");
    }

    // The stored password only goes to the server it was saved for: otherwise a changed host (with security "none")
    // would hand it to whoever runs that server.
    const connectionChanged = (["host", "port", "security", "username"] as const).some((field) => mail[field] !== current[field]);
    if (current.passwordBox !== null && connectionChanged && password === undefined) {
      if (mode === "save") throw HttpError.badRequest("password: enter the SMTP password again: the server settings changed.");
      password = null; // A test without the stored password: an anonymous attempt.
    }

    const needsRelay = mode === "test" || mail.enabled;
    const verb = mode === "test" ? "sending a test email" : "turning mail on";
    if (needsRelay && mail.host === "") throw HttpError.badRequest(`host: enter the SMTP server before ${verb}.`);
    if (needsRelay && mail.fromAddress === "") throw HttpError.badRequest(`fromAddress: enter the sender address before ${verb}.`);
    if (mode === "save" && input.requireConfirmedEmail === true && !mail.enabled) {
      throw HttpError.badRequest("requireConfirmedEmail: turn mail on before requiring a confirmed email address.");
    }
    return { mail, password, changes };
  }

  /**
   * A trimmed single-line text of at most `max` characters, or null for null or an empty value.
   */
  private static _optionalText(field: string, value: unknown, max: number): string | null {
    if (value === null) return null;
    if (typeof value !== "string") throw HttpError.badRequest(`${field} must be a string or null.`);
    const text = value.trim();
    if (text.length > max) throw HttpError.badRequest(`${field} must be at most ${max} characters.`);
    // deno-lint-ignore no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) throw HttpError.badRequest(`${field} can't contain line breaks or control characters.`);
    return text === "" ? null : text;
  }
  //#endregion
}

export namespace Setting {
  /**
   * Every key and the shape stored under it.
   */
  export interface Values {
    mail: StoredMail;
    catalogs: StoredCatalogs; // M9
  }

  export type Key = keyof Values;

  /**
   * The mail relay as stored. `passwordBox` is the SMTP password sealed by `lib/secretBox.ts` (never plain).
   */
  export interface StoredMail {
    enabled: boolean;
    host: string;
    port: number;
    security: "tls" | "starttls" | "none";
    username: string | null;
    passwordBox: string | null;
    fromAddress: string;
    fromName: string | null;
    verifyCertificate: boolean;
    requireConfirmedEmail: boolean;
  }

  /**
   * Mod catalog credentials (M9). `curseforgeKeyBox` is the operator's CurseForge API key sealed by
   * `lib/secretBox.ts` (never plain); null = none.
   */
  export interface StoredCatalogs {
    curseforgeKeyBox: string | null;
  }

  export interface CacheEntry {
    value: Values[Key];
    updatedAt: Date;
  }

  /**
   * `Setting.mergeMail()`'s result. `mail.passwordBox` is still the current one; `password`: undefined = keep it,
   * null = remove it, a string = the new plain password (seal it before storing).
   */
  export interface MailDraft {
    mail: StoredMail;
    password: string | null | undefined;
    changes: string[]; // Field names that change (`password` for the password), for the audit log.
  }
}

export type SettingAttributes = InferAttributes<Setting>;
export default Setting;
