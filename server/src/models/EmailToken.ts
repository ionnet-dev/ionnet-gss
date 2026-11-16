import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  literal,
  Model,
  Op,
  type Sequelize,
  type Transaction,
} from "sequelize";
import { LIMITS } from "@shared/constants.ts";
import { digestEquals, randomToken, sha256Hex } from "../lib/tokens.ts";
import { ID, intFk } from "./columns.ts";
import type { User } from "./User.ts";

const SWEEP_INTERVAL_MS = 60 * 60_000;
const SWEEP_KEEP_MS = 24 * 60 * 60_000; // Expired and used rows stay this long (for support questions), then go.

/**
 * A link or code the panel emailed (M7). Only the SHA-256 of the secret is stored; `email` is the address it went
 * to (a confirmation is valid only while that address is still the user's `email` or `pendingEmail`). Single use:
 * consuming is a conditional `UPDATE … SET used_at WHERE used_at IS NULL AND expires_at > now`.
 */
export class EmailToken extends Model<InferAttributes<EmailToken>, InferCreationAttributes<EmailToken>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User["id"]>;
  declare purpose: EmailToken.Purpose;
  declare tokenHash: string; // SHA-256 hex of the link token or the 6-digit code.
  declare email: string; // The address it was sent to.
  declare attempts: CreationOptional<number>; // Wrong tries (codes only).
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    EmailToken.init({
      id: ID,
      userId: intFk(false),
      purpose: { type: DataTypes.STRING(16), allowNull: false },
      tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
      email: { type: DataTypes.STRING(255), allowNull: false },
      attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "email_tokens", indexes: [{ fields: ["token_hash"] }, { fields: ["user_id", "purpose"] }] });
  }

  //#region Links
  /**
   * Issue a link token: 32 random bytes as base64url, stored as SHA-256. Deletes the user's unused tokens of the same
   * purpose first (one live link per purpose; `reset` and `welcome` replace each other).
   * @param email The address the link goes to.
   * @param ttlMs How long the link works. Unit is in milliseconds.
   * @returns The plain token, for the link only.
   */
  public static async issueLink(userId: number, purpose: EmailToken.LinkPurpose, email: string, ttlMs: number, transaction?: Transaction): Promise<string> {
    const token = randomToken("");
    const tokenHash = await sha256Hex(token);
    await EmailToken.replace(userId, purpose, { email, tokenHash, expiresAt: new Date(Date.now() + ttlMs) }, transaction);
    return token;
  }

  /**
   * The unused, unexpired link for `token` among `purposes`, without using it (previews). null otherwise.
   */
  public static async findLink(token: unknown, purposes: EmailToken.LinkPurpose[]): Promise<EmailToken | null> {
    if (!EmailToken.isLinkToken(token)) return null;
    return await EmailToken.findOne({
      where: { tokenHash: await sha256Hex(token), purpose: purposes, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    });
  }

  /**
   * The user's newest unused, unexpired link among `purposes`, or null (forgot password must not cancel a fresh
   * one).
   */
  public static async findLiveLink(userId: number, purposes: EmailToken.LinkPurpose[]): Promise<EmailToken | null> {
    return await EmailToken.findOne({
      where: { userId, purpose: purposes, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
      order: [["id", "DESC"]],
    });
  }

  /**
   * Use up a link: a conditional `UPDATE … SET used_at WHERE token_hash AND purpose IN AND used_at IS NULL AND
   * expires_at > now`, so of two requests with the same link only one gets the row.
   * @returns The used row, or null when the link is unknown, expired, of another purpose or already used.
   */
  public static async consumeLink(token: unknown, purposes: EmailToken.LinkPurpose[], transaction?: Transaction): Promise<EmailToken | null> {
    if (!EmailToken.isLinkToken(token)) return null;
    const tokenHash = await sha256Hex(token);
    const [affected] = await EmailToken.update({ usedAt: new Date() }, {
      where: { tokenHash, purpose: purposes, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
      transaction,
    });
    if (affected === 0) return null;
    return await EmailToken.findOne({ where: { tokenHash, purpose: purposes }, order: [["id", "DESC"]], transaction });
  }

  // 32 bytes as base64url are 43 characters; anything else can't be one of ours.
  private static isLinkToken(token: unknown): token is string {
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  }
  //#endregion

  //#region Codes
  /**
   * Issue a 6-digit code (valid `LIMITS.EMAIL_CODE_TTL_MINUTES`, `LIMITS.EMAIL_CODE_MAX_ATTEMPTS` tries), stored as
   * SHA-256. Deletes the user's unused codes of the same purpose first.
   * @returns The plain code, for the email only.
   */
  public static async issueCode(userId: number, purpose: EmailToken.CodePurpose, email: string): Promise<string> {
    const code = EmailToken.randomCode();
    const expiresAt = new Date(Date.now() + LIMITS.EMAIL_CODE_TTL_MINUTES * 60_000);
    await EmailToken.replace(userId, purpose, { email, tokenHash: await sha256Hex(code), expiresAt });
    return code;
  }

  /**
   * Check a code against the user's newest unused, unexpired code of `purpose`. Every try first takes one attempt by
   * a conditional `attempts = attempts + 1 WHERE attempts < EMAIL_CODE_MAX_ATTEMPTS` (so parallel guesses can't
   * exceed the limit), then compares in constant time, then marks the code used by a conditional update.
   * @param email The account's current address: a code sent to an earlier one doesn't count.
   * @returns The used row, or null when the code is wrong, used, expired, out of attempts or for another address.
   */
  public static async consumeCode(userId: number, purpose: EmailToken.CodePurpose, code: string, email: string): Promise<EmailToken | null> {
    const now = new Date();
    const row = await EmailToken.findOne({
      where: { userId, purpose, email, usedAt: null, expiresAt: { [Op.gt]: now } },
      order: [["id", "DESC"]],
    });
    if (!row) return null;
    const [counted] = await EmailToken.update({ attempts: literal("attempts + 1") }, {
      where: { id: row.id, usedAt: null, attempts: { [Op.lt]: LIMITS.EMAIL_CODE_MAX_ATTEMPTS } },
    });
    if (counted !== 1) return null;
    if (!digestEquals(await sha256Hex(code), row.tokenHash)) return null;
    const [used] = await EmailToken.update({ usedAt: new Date() }, { where: { id: row.id, usedAt: null, expiresAt: { [Op.gt]: new Date() } } });
    return used === 1 ? row : null;
  }

  /**
   * Whether the user has a code of `purpose` that can still be used (unused, unexpired, tries left).
   */
  public static async hasLiveCode(userId: number, purpose: EmailToken.CodePurpose): Promise<boolean> {
    const count = await EmailToken.count({
      where: { userId, purpose, usedAt: null, expiresAt: { [Op.gt]: new Date() }, attempts: { [Op.lt]: LIMITS.EMAIL_CODE_MAX_ATTEMPTS } },
    });
    return count > 0;
  }

  /**
   * Six random digits without modulo bias: 32-bit values at or above the largest multiple of 10^6 are drawn again.
   */
  private static randomCode(): string {
    const range = 10 ** LIMITS.TOTP_DIGITS;
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    const buffer = new Uint32Array(1);
    let value: number;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    } while (value >= limit);
    return String(value % range).padStart(LIMITS.TOTP_DIGITS, "0");
  }
  //#endregion

  //#region Housekeeping
  /**
   * Delete the user's unused tokens of `purposes` (address changed, password set, two-factor turned off).
   */
  public static async revoke(userId: number, purposes: EmailToken.Purpose[], transaction?: Transaction): Promise<void> {
    await EmailToken.destroy({ where: { userId, purpose: purposes, usedAt: null }, transaction });
  }

  /**
   * Delete rows that expired or were used more than a day ago, now and then every hour.
   * @returns A function that stops the sweep.
   */
  public static startSweep(): () => void {
    const sweep = async () => {
      const cutoff = new Date(Date.now() - SWEEP_KEEP_MS);
      try {
        await EmailToken.destroy({ where: { [Op.or]: [{ expiresAt: { [Op.lt]: cutoff } }, { usedAt: { [Op.lt]: cutoff } }] } });
      } catch (error) {
        console.error("email token sweep failed", error);
      }
    };
    void sweep();
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    Deno.unrefTimer(timer);
    return () => clearInterval(timer);
  }

  // One live token per purpose: `reset` and `welcome` share a slot.
  private static async replace(userId: number, purpose: EmailToken.Purpose, data: { email: string; tokenHash: string; expiresAt: Date }, transaction?: Transaction): Promise<void> {
    const purposes: EmailToken.Purpose[] = purpose === "reset" || purpose === "welcome" ? ["reset", "welcome"] : [purpose];
    const write = async (t: Transaction): Promise<void> => {
      await EmailToken.revoke(userId, purposes, t);
      await EmailToken.create({ userId, purpose, ...data, usedAt: null }, { transaction: t });
    };
    if (transaction) await write(transaction);
    else await EmailToken.sequelize!.transaction(write);
  }
  //#endregion
}

export namespace EmailToken {
  /**
   * `confirm`: confirm `email` (the account's address or its pending one). `reset`: forgot password / admin-sent
   * reset. `welcome`: first password of an account an admin created. `login`: sign-in code. `action`: code proving a
   * sensitive action (disable two-factor, new recovery codes).
   */
  export type Purpose = "confirm" | "reset" | "welcome" | "login" | "action";

  /**
   * Purposes sent as a link (`issueLink`).
   */
  export type LinkPurpose = "confirm" | "reset" | "welcome";

  /**
   * Purposes sent as a 6-digit code (`issueCode`).
   */
  export type CodePurpose = "login" | "action";
}

export type EmailTokenAttributes = InferAttributes<EmailToken>;
export default EmailToken;
