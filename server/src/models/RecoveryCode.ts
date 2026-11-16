import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
  type Transaction,
} from "sequelize";
import { HttpError } from "../lib/HttpError.ts";
import { ID, intFk } from "./columns.ts";
import type { User } from "./User.ts";

/**
 * A single-use TOTP recovery code (M5). Only the SHA-256 of the normalized code is stored; the plain codes are shown
 * once, when issued. Format `xxxxx-xxxxx` (10 lowercase base32 characters, 50 bits).
 */
export class RecoveryCode extends Model<InferAttributes<RecoveryCode>, InferCreationAttributes<RecoveryCode>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User["id"]>;
  declare codeHash: string; // SHA-256 hex of the normalized code (`normalize()`).
  declare usedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    RecoveryCode.init({
      id: ID,
      userId: intFk(false),
      codeHash: { type: DataTypes.CHAR(64), allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "recovery_codes", indexes: [{ fields: ["user_id"] }] });
  }

  /**
   * The code as stored before hashing: lowercased, spaces and dashes removed. null when it can't be a recovery code
   * (see `LIMITS.RECOVERY_CODE_PATTERN`).
   */
  public static normalize(code: string): string | null {
    throw HttpError.notImplemented("RecoveryCode.normalize"); // TODO(builder): M5
  }

  /**
   * Replace every recovery code of the user with `LIMITS.RECOVERY_CODES` new ones.
   * @returns The plain codes, formatted `xxxxx-xxxxx`, to show once.
   */
  public static async issue(userId: number, transaction?: Transaction): Promise<string[]> {
    throw HttpError.notImplemented("RecoveryCode.issue"); // TODO(builder): M5
  }

  /**
   * Use up one code: a conditional `UPDATE … SET used_at = now WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
   * so two requests with the same code can't both succeed.
   * @returns Whether the code was valid and unused.
   */
  public static async consume(userId: number, code: string): Promise<boolean> {
    throw HttpError.notImplemented("RecoveryCode.consume"); // TODO(builder): M5
  }

  /**
   * Unused codes the user has left.
   */
  public static async countLeft(userId: number): Promise<number> {
    return await RecoveryCode.count({ where: { userId, usedAt: null } });
  }

  /**
   * Delete every code of the user (2FA turned off or reset).
   */
  public static async removeAll(userId: number, transaction?: Transaction): Promise<void> {
    await RecoveryCode.destroy({ where: { userId }, transaction });
  }
}

export type RecoveryCodeAttributes = InferAttributes<RecoveryCode>;
export default RecoveryCode;
