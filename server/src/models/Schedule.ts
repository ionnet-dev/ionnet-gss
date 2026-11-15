import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";
import { ID, uuidFk } from "./columns.ts";
import type { GameServer } from "./GameServer.ts";

/**
 * A recurring action on a server. Designed for in v1, built later: the table exists so nothing moves when it lands.
 */
export class Schedule extends Model<InferAttributes<Schedule>, InferCreationAttributes<Schedule>> {
  declare id: CreationOptional<number>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare name: string;
  declare cron: string; // Five-field cron in the panel's time zone (UTC).
  declare action: Schedule.Action;
  declare payload: string | null; // `command`: the console line.
  declare enabled: CreationOptional<boolean>;
  declare lastRunAt: Date | null;
  declare nextRunAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Schedule.init({
      id: ID,
      serverId: uuidFk(false),
      name: { type: DataTypes.STRING(64), allowNull: false },
      cron: { type: DataTypes.STRING(64), allowNull: false },
      action: { type: DataTypes.ENUM(...Schedule.ACTIONS), allowNull: false },
      payload: { type: DataTypes.STRING(500), allowNull: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      lastRunAt: { type: DataTypes.DATE, allowNull: true },
      nextRunAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "schedules" });
  }
}

export namespace Schedule {
  export const ACTIONS = ["start", "stop", "restart", "backup", "command"] as const;
  export type Action = typeof ACTIONS[number];
}

export type ScheduleAttributes = InferAttributes<Schedule>;
export default Schedule;
