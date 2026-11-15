import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
} from "sequelize";
import type { EnrolTokenDto } from "@shared/api/hosts.ts";
import { LIMITS, TOKEN_PREFIX } from "@shared/constants.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { randomToken, sha256Hex, tokenHint } from "../lib/tokens.ts";
import { ID, intFk, uuidFk } from "./columns.ts";
import type { Host } from "./Host.ts";
import type { User } from "./User.ts";

const MAX_TOKEN_MINUTES = 60 * 24 * 30;

/**
 * A one-time token (`gss_enrol_…`) an admin creates to enrol a host. Only its SHA-256 is stored.
 */
export class EnrolToken extends Model<InferAttributes<EnrolToken>, InferCreationAttributes<EnrolToken>> {
  declare id: CreationOptional<number>;
  declare tokenHash: string;
  declare tokenHint: string;
  declare name: string | null; // Name for the new host. null = its hostname.
  declare createdById: ForeignKey<User["id"]> | null;
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare hostId: ForeignKey<Host["id"]> | null; // The host that used it.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare createdBy?: NonAttribute<User | null>;

  public static initModel(sequelize: Sequelize): void {
    EnrolToken.init({
      id: ID,
      tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      tokenHint: { type: DataTypes.STRING(16), allowNull: false },
      name: { type: DataTypes.STRING(64), allowNull: true },
      createdById: intFk(true),
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      hostId: uuidFk(true),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "enrol_tokens" });
  }

  /**
   * Create a token and return it with its plain value (the only time it exists).
   */
  public static async createToken(createdBy: User, opts?: EnrolToken.CreateOptions): Promise<{ enrolToken: EnrolToken; token: string }> {
    opts ??= {};
    const minutes = opts.expiresInMinutes ?? Config.ENROL_TOKEN_TTL_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TOKEN_MINUTES) {
      throw HttpError.badRequest(`The token lifetime must be a whole number of minutes between 1 and ${MAX_TOKEN_MINUTES}.`);
    }
    let name: string | null = null;
    if (opts.name !== undefined && opts.name !== null) {
      if (typeof opts.name !== "string") throw HttpError.badRequest("The host name must be a string.");
      name = opts.name.trim() || null;
      if (name !== null && name.length > LIMITS.HOST_NAME_MAX) {
        throw HttpError.badRequest(`The host name can be at most ${LIMITS.HOST_NAME_MAX} characters long.`);
      }
    }

    const token = randomToken(TOKEN_PREFIX.ENROL);
    const created = await EnrolToken.create({
      tokenHash: await sha256Hex(token),
      tokenHint: tokenHint(token),
      name,
      createdById: createdBy.id,
      expiresAt: new Date(Date.now() + minutes * 60_000),
      usedAt: null,
      hostId: null,
    });
    const enrolToken = await EnrolToken.findByPk(created.id, { include: [{ association: "createdBy" }] });
    return { enrolToken: enrolToken!, token };
  }

  /**
   * Every token, newest first, with `createdBy` loaded.
   */
  public static async listAll(): Promise<EnrolToken[]> {
    return await EnrolToken.findAll({ include: [{ association: "createdBy" }], order: [["createdAt", "DESC"], ["id", "DESC"]] });
  }

  /**
   * The unused, unexpired token for a plain value, or null. Used by `Host.enrol()`.
   */
  public static async findUsable(token: string): Promise<EnrolToken | null> {
    const enrolToken = await EnrolToken.findOne({ where: { tokenHash: await sha256Hex(token) } });
    return enrolToken?.isUsable() ? enrolToken : null;
  }

  public isUsable(): boolean {
    return this.usedAt === null && this.expiresAt.getTime() > Date.now();
  }

  /**
   * Needs `createdBy` loaded.
   */
  public toClientJSON(): EnrolTokenDto {
    return {
      id: this.id,
      name: this.name,
      tokenHint: this.tokenHint,
      createdBy: this.createdBy?.username ?? null,
      expiresAt: this.expiresAt.toISOString(),
      usedAt: this.usedAt?.toISOString() ?? null,
      hostId: this.hostId,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

export namespace EnrolToken {
  export interface CreateOptions {
    name?: string | null;
    expiresInMinutes?: number; // Default: ENROL_TOKEN_TTL_MINUTES.
  }
}

export type EnrolTokenAttributes = InferAttributes<EnrolToken>;
export default EnrolToken;
