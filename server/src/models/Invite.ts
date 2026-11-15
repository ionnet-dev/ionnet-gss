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
import type { InviteDto } from "@shared/api/invites.ts";
import { TOKEN_PREFIX } from "@shared/constants.ts";
import { ROLES } from "@shared/permissions.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { randomToken, sha256Hex, tokenHint } from "../lib/tokens.ts";
import { ID, intFk } from "./columns.ts";
import { Role } from "./Role.ts";
import { User } from "./User.ts";

const MAX_INVITE_HOURS = 24 * 365;
const INCLUDE = [{ association: "role" }, { association: "createdBy" }, { association: "usedBy" }];

/**
 * A one-time registration link. The code (`gss_inv_…`) is shown once; only its SHA-256 is stored.
 */
export class Invite extends Model<InferAttributes<Invite>, InferCreationAttributes<Invite>> {
  declare id: CreationOptional<number>;
  declare codeHash: string;
  declare codeHint: string;
  declare email: string | null; // null = anyone with the link.
  declare roleId: ForeignKey<Role["id"]>;
  declare createdById: ForeignKey<User["id"]> | null;
  declare usedById: ForeignKey<User["id"]> | null;
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare role?: NonAttribute<Role>;
  declare createdBy?: NonAttribute<User | null>;
  declare usedBy?: NonAttribute<User | null>;

  public static initModel(sequelize: Sequelize): void {
    Invite.init({
      id: ID,
      codeHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      codeHint: { type: DataTypes.STRING(16), allowNull: false },
      email: { type: DataTypes.STRING(255), allowNull: true },
      roleId: intFk(false),
      createdById: intFk(true),
      usedById: intFk(true),
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "invites" });
  }

  /**
   * Create an invite and return it with its plain code (the only time the code exists).
   */
  public static async createInvite(createdBy: User, opts?: Invite.CreateOptions): Promise<{ invite: Invite; code: string }> {
    opts ??= {};
    const hours = opts.expiresInHours ?? Config.INVITE_TTL_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_INVITE_HOURS) {
      throw HttpError.badRequest(`The invite lifetime must be a whole number of hours between 1 and ${MAX_INVITE_HOURS}.`);
    }
    const email = User.normalizeEmail(opts.email);
    const roleName = opts.roleName ?? ROLES.USER;
    const role = typeof roleName === "string" ? await Role.getRoleByName(roleName) : null;
    if (!role) throw HttpError.badRequest(`Unknown role: ${roleName}.`);

    const code = randomToken(TOKEN_PREFIX.INVITE);
    const created = await Invite.create({
      codeHash: await sha256Hex(code),
      codeHint: tokenHint(code),
      email,
      roleId: role.id,
      createdById: createdBy.id,
      usedById: null,
      expiresAt: new Date(Date.now() + hours * 3600_000),
      usedAt: null,
    });
    const invite = await Invite.findByPk(created.id, { include: INCLUDE });
    return { invite: invite!, code };
  }

  /**
   * Every invite, newest first, with `role`, `createdBy` and `usedBy` loaded.
   */
  public static async listAll(): Promise<Invite[]> {
    return await Invite.findAll({ include: INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });
  }

  /**
   * The invite for a plain code, or null when unknown. Does not check expiry or use; see `isUsable()`.
   */
  public static async findByCode(code: string): Promise<Invite | null> {
    if (typeof code !== "string" || code === "") return null;
    return await Invite.findOne({ where: { codeHash: await sha256Hex(code) }, include: INCLUDE });
  }

  /**
   * Create the user and mark the invite used, in one transaction.
   * @throws HttpError 400 when the invite is used, expired, or bound to another email.
   */
  public static async redeem(code: string, data: { username: string; password: string; email?: string | null }): Promise<User> {
    const invite = await Invite.findByCode(code);
    const unusable = "This invite has expired or was already used.";
    if (!invite || !invite.isUsable()) throw HttpError.badRequest(unusable);

    let email = User.normalizeEmail(data.email);
    if (invite.email !== null) {
      if (email !== null && email !== invite.email.toLowerCase()) {
        throw HttpError.badRequest("This invite was issued for a different email address.");
      }
      email = invite.email.toLowerCase();
    }

    return await Invite.sequelize!.transaction(async (transaction) => {
      const user = await User.registerUser({
        username: data.username,
        password: data.password,
        email,
        roleNames: [invite.role!.name],
        invitedById: invite.createdById,
      }, transaction);
      // Conditional update: of two simultaneous redemptions only one flips `usedAt`.
      const [claimed] = await Invite.update({ usedAt: new Date(), usedById: user.id }, { where: { id: invite.id, usedAt: null }, transaction });
      if (claimed !== 1) throw HttpError.badRequest(unusable);
      return user;
    });
  }

  public isUsable(): boolean {
    return this.usedAt === null && this.expiresAt.getTime() > Date.now();
  }

  /**
   * Needs `role`, `createdBy` and `usedBy` loaded.
   */
  public toClientJSON(): InviteDto {
    return {
      id: this.id,
      codeHint: this.codeHint,
      email: this.email,
      role: this.role?.name ?? "",
      createdBy: this.createdBy?.username ?? null,
      usedBy: this.usedBy?.username ?? null,
      expiresAt: this.expiresAt.toISOString(),
      usedAt: this.usedAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

export namespace Invite {
  export interface CreateOptions {
    email?: string | null;
    roleName?: string; // Default: ROLES.USER.
    expiresInHours?: number; // Default: INVITE_TTL_HOURS.
  }
}

export type InviteAttributes = InferAttributes<Invite>;
export default Invite;
