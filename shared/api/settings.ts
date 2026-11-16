/**
 * `/api/settings` (M7): panel settings stored in the database and edited in the UI. Administrators only: whoever
 * controls the mail relay can read every password link, so this is admin power, not a separate permission.
 */
import type { IsoDate } from "./common.ts";

/**
 * How the panel talks to the SMTP server. `tls`: TLS from the first byte (usually port 465). `starttls`: plain
 * connection upgraded with STARTTLS, refused when the server doesn't offer it (usually 587). `none`: no encryption
 * (a relay on the same machine or private network, port 25 or a dev catcher on 1025).
 */
export type MailSecurity = "tls" | "starttls" | "none";

/**
 * `GET /api/settings/mail`. The SMTP password never leaves the panel: `hasPassword` says whether one is stored.
 */
export interface MailSettingsDto {
  /**
   * Off: the panel sends no email at all; password links, email two-factor codes and confirmations are unavailable,
   * and `requireConfirmedEmail` doesn't apply.
   */
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null; // null = no SMTP authentication.
  hasPassword: boolean;
  /**
   * The password is stored but can't be decrypted (JWT_SECRET changed since it was saved). Enter it again.
   */
  passwordUnreadable: boolean;
  fromAddress: string; // Envelope and `From:` address.
  fromName: string | null; // Display name in `From:`; null = APP_NAME.
  /**
   * Check the server's TLS certificate (on by default). Off only for a relay with a self-signed certificate.
   */
  verifyCertificate: boolean;
  /**
   * Non-admins sign in only with a confirmed email address. Applies only while `enabled`.
   */
  requireConfirmedEmail: boolean;
  updatedAt: IsoDate | null; // null = never saved.
}

/**
 * `PUT /api/settings/mail`. Absent fields stay as they are. `password`: absent = keep, `null` or `""` = remove, a
 * string = replace. Turning `enabled` on needs `host` and `fromAddress`. 400 names the field that's wrong.
 */
export interface UpdateMailSettingsBody {
  enabled?: boolean;
  host?: string;
  port?: number; // 1-65535.
  security?: MailSecurity;
  username?: string | null;
  password?: string | null;
  fromAddress?: string;
  fromName?: string | null;
  verifyCertificate?: boolean;
  requireConfirmedEmail?: boolean;
}

/**
 * `POST /api/settings/mail/test`: send a test email to `to`. With `settings`, those (unsaved) values are merged over
 * the stored ones for this one send, so a form can be tried before saving; `enabled` is ignored. 502 `{ message }`
 * with the SMTP server's answer when sending fails.
 */
export interface TestMailBody {
  to: string;
  settings?: UpdateMailSettingsBody;
}

/**
 * `GET /api/settings/catalogs` (M9): credentials for mod catalogs. Only CurseForge needs one: its API and CDN take the
 * operator's own key from https://console.curseforge.com (the panel never uses another app's key or a proxy). The key
 * never leaves the panel; it is stored encrypted like the SMTP password.
 */
export interface CatalogSettingsDto {
  curseforge: {
    hasApiKey: boolean;
    keyUnreadable: boolean; // Stored but can't be decrypted (JWT_SECRET changed); enter it again.
    updatedAt: IsoDate | null;
  };
}

/**
 * `PUT /api/settings/catalogs`. `curseforgeApiKey`: absent = keep, `null` or `""` = remove, a string = replace (checked
 * against the CurseForge API first; 400 with CurseForge's answer when it is refused).
 */
export interface UpdateCatalogSettingsBody {
  curseforgeApiKey?: string | null;
}

/**
 * `POST /api/settings/catalogs/test`: try the given key (or the stored one when absent) against the CurseForge API.
 */
export interface TestCatalogBody {
  curseforgeApiKey?: string;
}

export interface TestCatalogResponse {
  ok: boolean;
  message: string; // e.g. "CurseForge accepted the key." or its refusal.
}
