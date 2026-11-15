/**
 * Column helpers shared by the model definitions, so every `init()` stays uniform.
 */
import { DataTypes, type ModelAttributeColumnOptions } from "sequelize";

/**
 * Auto-increment unsigned integer primary key (the default for every table except hosts and game servers).
 */
export const ID: ModelAttributeColumnOptions = {
  type: DataTypes.INTEGER.UNSIGNED,
  autoIncrement: true,
  primaryKey: true,
};

/**
 * Random UUID primary key, for hosts and game servers (they name folders and containers and appear in URLs).
 */
export const UUID_ID: ModelAttributeColumnOptions = {
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
};

/**
 * Integer foreign key column.
 */
export function intFk(allowNull = false): ModelAttributeColumnOptions {
  return { type: DataTypes.INTEGER.UNSIGNED, allowNull };
}

/**
 * UUID foreign key column.
 */
export function uuidFk(allowNull = false): ModelAttributeColumnOptions {
  return { type: DataTypes.UUID, allowNull };
}

/**
 * A JSON column. MariaDB stores JSON as LONGTEXT, so mysql2 hands it back as a string; the getter parses it.
 * @param field The attribute name, needed by the getter.
 * @param fallback Value returned for NULL. Default is `null`.
 */
export function jsonColumn(field: string, allowNull = false, fallback: unknown = null): ModelAttributeColumnOptions {
  return {
    type: DataTypes.JSON,
    allowNull,
    get(this: { getDataValue(key: string): unknown }) {
      const raw = this.getDataValue(field);
      if (raw === null || raw === undefined) return fallback;
      if (typeof raw !== "string") return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
  };
}
