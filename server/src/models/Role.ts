import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
  type Transaction,
} from "sequelize";
import type { RoleDto } from "@shared/api/users.ts";
import { type Permission, ROLES } from "@shared/permissions.ts";
import { ID, intFk, jsonColumn } from "./columns.ts";

/**
 * A named set of permission keys. `admin` passes every check whatever its keys; a role may inherit another's keys.
 * `admin` and `user` are seeded by the first migration.
 */
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare description: string | null;
  declare permissions: CreationOptional<Permission[]>;
  declare inheritsId: ForeignKey<Role["id"]> | null; // null = inherits nothing.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare inherits?: NonAttribute<Role | null>;

  public static initModel(sequelize: Sequelize): void {
    Role.init({
      id: ID,
      name: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
      permissions: { ...jsonColumn("permissions", false, []), defaultValue: [] },
      inheritsId: intFk(true),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "roles" });
  }

  public static async getRoleByName(name: string): Promise<Role | null> {
    return await Role.findOne({ where: { name } });
  }

  public isAdminRole(): boolean {
    return this.name === ROLES.ADMIN;
  }

  /**
   * This role's keys plus every inherited role's, following `inheritsId` up the chain (cycles are cut).
   */
  public async resolvePermissions(transaction?: Transaction): Promise<Set<Permission>> {
    const permissions = new Set<Permission>(this.permissions);
    const seen = new Set<number>([this.id]);
    let parentId = this.inheritsId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = await Role.findByPk(parentId, { transaction });
      if (!parent) break;
      for (const permission of parent.permissions) permissions.add(permission);
      parentId = parent.inheritsId;
    }
    return permissions;
  }

  public toClientJSON(): RoleDto {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      permissions: this.permissions,
      inherits: this.inherits?.name ?? null,
    };
  }
}

export type RoleAttributes = InferAttributes<Role>;
export default Role;
