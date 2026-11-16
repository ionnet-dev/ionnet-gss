/**
 * The Sequelize instance, every model initialised, and every association. Import models from here (outside this
 * folder) so they are always initialised. Main-session only: a new model is added here once, by the main session.
 */
import { Sequelize } from "sequelize";
import mysql2 from "mysql2";
import { Config } from "../Config.ts";
import { User } from "./User.ts";
import { Role } from "./Role.ts";
import { Quota } from "./Quota.ts";
import { Invite } from "./Invite.ts";
import { Host } from "./Host.ts";
import { HostGrant } from "./HostGrant.ts";
import { EnrolToken } from "./EnrolToken.ts";
import { Source } from "./Source.ts";
import { Definition } from "./Definition.ts";
import { GameServer } from "./GameServer.ts";
import { PortAllocation } from "./PortAllocation.ts";
import { Backup } from "./Backup.ts";
import { ServerShare } from "./ServerShare.ts";
import { Schedule } from "./Schedule.ts";
import { AuditLog } from "./AuditLog.ts";
import { RecoveryCode } from "./RecoveryCode.ts";

/**
 * The one Sequelize instance. MariaDB through the mysql dialect; columns are snake_case (`underscored`).
 */
export const sequelize = new Sequelize(Config.DB_NAME, Config.DB_USER, Config.DB_PASSWORD, {
  host: Config.DB_HOST,
  port: Config.DB_PORT,
  dialect: "mysql",
  dialectModule: mysql2, // Explicit: Sequelize's dynamic require() doesn't resolve under Deno.
  logging: Config.LOG_SQL ? (sql) => console.debug(sql) : false,
  define: { underscored: true, timestamps: true },
  pool: { max: 10, min: 0, idle: 10_000 },
  timezone: "+00:00",
});

//#region Init
for (const model of [User, Role, Quota, Invite, Host, HostGrant, EnrolToken, Source, Definition, GameServer, PortAllocation, Backup, ServerShare, Schedule, AuditLog, RecoveryCode]) {
  model.initModel(sequelize);
}
//#endregion

//#region Associations
// Accounts
User.belongsToMany(Role, { through: "user_roles", as: "roles", foreignKey: "userId", otherKey: "roleId" });
Role.belongsToMany(User, { through: "user_roles", as: "users", foreignKey: "roleId", otherKey: "userId" });
Role.belongsTo(Role, { as: "inherits", foreignKey: "inheritsId" });
User.hasOne(Quota, { as: "quota", foreignKey: "userId", onDelete: "CASCADE" });
Quota.belongsTo(User, { as: "user", foreignKey: "userId" });
User.belongsTo(User, { as: "invitedBy", foreignKey: "invitedById" });
User.hasMany(RecoveryCode, { as: "recoveryCodes", foreignKey: "userId", onDelete: "CASCADE" });
Invite.belongsTo(Role, { as: "role", foreignKey: "roleId" });
Invite.belongsTo(User, { as: "createdBy", foreignKey: "createdById" });
Invite.belongsTo(User, { as: "usedBy", foreignKey: "usedById" });

// Hosts
Host.belongsTo(User, { as: "enrolledBy", foreignKey: "enrolledById" });
Host.hasMany(HostGrant, { as: "grants", foreignKey: "hostId", onDelete: "CASCADE" });
HostGrant.belongsTo(Host, { as: "host", foreignKey: "hostId" });
HostGrant.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(HostGrant, { as: "hostGrants", foreignKey: "userId", onDelete: "CASCADE" });
EnrolToken.belongsTo(User, { as: "createdBy", foreignKey: "createdById" });
EnrolToken.belongsTo(Host, { as: "host", foreignKey: "hostId" });

// Definitions
Source.hasMany(Definition, { as: "definitions", foreignKey: "sourceId", onDelete: "CASCADE" });
Definition.belongsTo(Source, { as: "source", foreignKey: "sourceId" });

// Game servers
GameServer.belongsTo(User, { as: "owner", foreignKey: "ownerId" });
User.hasMany(GameServer, { as: "servers", foreignKey: "ownerId" });
GameServer.belongsTo(Host, { as: "host", foreignKey: "hostId" });
Host.hasMany(GameServer, { as: "servers", foreignKey: "hostId" });
GameServer.belongsTo(Definition, { as: "definition", foreignKey: "definitionId" });
GameServer.hasMany(PortAllocation, { as: "ports", foreignKey: "serverId", onDelete: "CASCADE" });
PortAllocation.belongsTo(GameServer, { as: "server", foreignKey: "serverId" });
PortAllocation.belongsTo(Host, { as: "host", foreignKey: "hostId" });
GameServer.hasMany(Backup, { as: "backups", foreignKey: "serverId", onDelete: "CASCADE" });
Backup.belongsTo(GameServer, { as: "server", foreignKey: "serverId" });
Backup.belongsTo(User, { as: "createdBy", foreignKey: "createdById" });
GameServer.hasMany(ServerShare, { as: "shares", foreignKey: "serverId", onDelete: "CASCADE" });
ServerShare.belongsTo(GameServer, { as: "server", foreignKey: "serverId" });
ServerShare.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(ServerShare, { as: "shares", foreignKey: "userId", onDelete: "CASCADE" });
GameServer.hasMany(Schedule, { as: "schedules", foreignKey: "serverId", onDelete: "CASCADE" });
Schedule.belongsTo(GameServer, { as: "server", foreignKey: "serverId" });

// Audit
AuditLog.belongsTo(User, { as: "actor", foreignKey: "actorId" });
//#endregion

/**
 * Connect and check the credentials. Throws a readable error when MariaDB is unreachable.
 */
export async function connectDatabase(): Promise<void> {
  try {
    await sequelize.authenticate();
  } catch (error) {
    throw new Error(`Can't reach MariaDB at ${Config.DB_HOST}:${Config.DB_PORT} (${(error as Error).message}). Start it with \`deno task db:up\` or check the DB_* settings in .env.`);
  }
}

/**
 * Whether the database answers, for `/api/health`.
 */
export async function isDatabaseUp(): Promise<boolean> {
  return await sequelize.query("SELECT 1").then(() => true).catch(() => false);
}

export { AuditLog, Backup, Definition, EnrolToken, GameServer, Host, HostGrant, Invite, PortAllocation, Quota, RecoveryCode, Role, Schedule, ServerShare, Source, User };
export default sequelize;
