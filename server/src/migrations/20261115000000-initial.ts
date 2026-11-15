/**
 * The whole v1 schema, so later milestones fill in behaviour without schema churn, plus the seeded `admin` and
 * `user` roles. Integer keys everywhere except hosts and game servers (UUIDs: they name folders and containers).
 */
import { DataTypes, type QueryInterface } from "sequelize";
import { DEFAULT_USER_PERMISSIONS, ROLES } from "@shared/permissions.ts";

const SERVER_STATES = ["creating", "installing", "install_failed", "stopped", "starting", "running", "stopping", "crashed"];

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

const id = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uuidId = { type: DataTypes.UUID, primaryKey: true };

function fk(table: string, onDelete: "CASCADE" | "SET NULL" | "RESTRICT", allowNull = false) {
  return { type: DataTypes.INTEGER.UNSIGNED, allowNull, references: { model: table, key: "id" }, onDelete, onUpdate: "CASCADE" };
}

function uuidFk(table: string, onDelete: "CASCADE" | "SET NULL" | "RESTRICT", allowNull = false) {
  return { type: DataTypes.UUID, allowNull, references: { model: table, key: "id" }, onDelete, onUpdate: "CASCADE" };
}

export async function up(qi: QueryInterface): Promise<void> {
  //#region Accounts
  await qi.createTable("roles", {
    id,
    name: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    description: { type: DataTypes.STRING(255), allowNull: true },
    permissions: { type: DataTypes.JSON, allowNull: false },
    inherits_id: fk("roles", "SET NULL", true),
    ...timestamps,
  });

  await qi.createTable("users", {
    id,
    username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    email: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    display_name: { type: DataTypes.STRING(64), allowNull: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    token_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    totp_secret: { type: DataTypes.STRING(64), allowNull: true },
    totp_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    invited_by_id: fk("users", "SET NULL", true),
    ...timestamps,
  });

  await qi.createTable("user_roles", {
    user_id: { ...fk("users", "CASCADE"), primaryKey: true },
    role_id: { ...fk("roles", "CASCADE"), primaryKey: true },
    ...timestamps,
  });

  await qi.createTable("quotas", {
    id,
    user_id: { ...fk("users", "CASCADE"), unique: true },
    max_servers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_memory_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_cpu_millis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_disk_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_backups: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    ...timestamps,
  });

  await qi.createTable("invites", {
    id,
    code_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    code_hint: { type: DataTypes.STRING(16), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: true },
    role_id: fk("roles", "RESTRICT"),
    created_by_id: fk("users", "SET NULL", true),
    used_by_id: fk("users", "SET NULL", true),
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  //#endregion

  //#region Hosts
  await qi.createTable("hosts", {
    id: uuidId,
    name: { type: DataTypes.STRING(64), allowNull: false },
    address: { type: DataTypes.STRING(255), allowNull: true },
    credential_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    credential_hint: { type: DataTypes.STRING(16), allowNull: false },
    facts: { type: DataTypes.JSON, allowNull: true },
    agent_version: { type: DataTypes.STRING(32), allowNull: true },
    protocol_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    port_pool: { type: DataTypes.STRING(255), allowNull: false },
    max_memory_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_cpu_millis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    max_disk_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    enrolled_by_id: fk("users", "SET NULL", true),
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });

  await qi.createTable("host_grants", {
    id,
    host_id: uuidFk("hosts", "CASCADE"),
    user_id: fk("users", "CASCADE"),
    created_by_id: fk("users", "SET NULL", true),
    ...timestamps,
  });
  await qi.addIndex("host_grants", ["host_id", "user_id"], { unique: true });

  await qi.createTable("enrol_tokens", {
    id,
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    token_hint: { type: DataTypes.STRING(16), allowNull: false },
    name: { type: DataTypes.STRING(64), allowNull: true },
    created_by_id: fk("users", "SET NULL", true),
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    host_id: uuidFk("hosts", "SET NULL", true),
    ...timestamps,
  });
  //#endregion

  //#region Definitions
  await qi.createTable("sources", {
    id,
    name: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    url: { type: DataTypes.STRING(512), allowNull: false },
    branch: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "main" },
    path: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_sync_at: { type: DataTypes.DATE, allowNull: true },
    last_commit: { type: DataTypes.STRING(64), allowNull: true },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    definition_errors: { type: DataTypes.JSON, allowNull: false },
    ...timestamps,
  });

  await qi.createTable("definitions", {
    id,
    source_id: fk("sources", "CASCADE"),
    game_id: { type: DataTypes.STRING(64), allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    commit: { type: DataTypes.STRING(64), allowNull: false },
    document: { type: DataTypes.JSON, allowNull: false },
    files: { type: DataTypes.JSON, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps,
  });
  await qi.addIndex("definitions", ["source_id", "game_id", "commit"], { unique: true });
  await qi.addIndex("definitions", ["source_id", "game_id", "active"]);
  //#endregion

  //#region Game servers
  await qi.createTable("game_servers", {
    id: uuidId,
    name: { type: DataTypes.STRING(64), allowNull: false },
    owner_id: fk("users", "RESTRICT"),
    host_id: uuidFk("hosts", "RESTRICT"),
    definition_id: fk("definitions", "RESTRICT"),
    state: { type: DataTypes.ENUM(...SERVER_STATES), allowNull: false, defaultValue: "creating" },
    state_reason: { type: DataTypes.TEXT, allowNull: true },
    last_exit_code: { type: DataTypes.INTEGER, allowNull: true },
    state_changed_at: { type: DataTypes.DATE, allowNull: false },
    variables: { type: DataTypes.JSON, allowNull: false },
    memory_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    cpu_millis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    disk_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    autostart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    auto_restart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    spec_hash: { type: DataTypes.CHAR(64), allowNull: true },
    installed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  await qi.addIndex("game_servers", ["owner_id"]);
  await qi.addIndex("game_servers", ["host_id"]);

  await qi.createTable("port_allocations", {
    id,
    host_id: uuidFk("hosts", "CASCADE"),
    server_id: uuidFk("game_servers", "CASCADE"),
    name: { type: DataTypes.STRING(32), allowNull: false },
    proto: { type: DataTypes.ENUM("tcp", "udp"), allowNull: false },
    port: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps,
  });
  await qi.addIndex("port_allocations", ["host_id", "proto", "port"], { unique: true });

  await qi.createTable("backups", {
    id,
    server_id: uuidFk("game_servers", "CASCADE"),
    created_by_id: fk("users", "SET NULL", true),
    name: { type: DataTypes.STRING(128), allowNull: false },
    status: { type: DataTypes.ENUM("pending", "running", "done", "failed"), allowNull: false, defaultValue: "pending" },
    file: { type: DataTypes.STRING(255), allowNull: true },
    size_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });

  await qi.createTable("server_shares", {
    id,
    server_id: uuidFk("game_servers", "CASCADE"),
    user_id: fk("users", "CASCADE"),
    role: { type: DataTypes.ENUM("view", "operate", "manage"), allowNull: false },
    ...timestamps,
  });
  await qi.addIndex("server_shares", ["server_id", "user_id"], { unique: true });

  await qi.createTable("schedules", {
    id,
    server_id: uuidFk("game_servers", "CASCADE"),
    name: { type: DataTypes.STRING(64), allowNull: false },
    cron: { type: DataTypes.STRING(64), allowNull: false },
    action: { type: DataTypes.ENUM("start", "stop", "restart", "backup", "command"), allowNull: false },
    payload: { type: DataTypes.STRING(500), allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_run_at: { type: DataTypes.DATE, allowNull: true },
    next_run_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  //#endregion

  //#region Audit
  await qi.createTable("audit_logs", {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    actor_id: fk("users", "SET NULL", true),
    action: { type: DataTypes.STRING(64), allowNull: false },
    host_id: { type: DataTypes.UUID, allowNull: true },
    server_id: { type: DataTypes.UUID, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex("audit_logs", ["created_at"]);
  await qi.addIndex("audit_logs", ["server_id"]);
  //#endregion

  //#region Seed
  const now = new Date();
  await qi.bulkInsert("roles", [
    { name: ROLES.ADMIN, description: "Everything: hosts, sources, users, every server.", permissions: JSON.stringify([]), inherits_id: null, created_at: now, updated_at: now },
    { name: ROLES.USER, description: "Own servers on granted hosts, within quota.", permissions: JSON.stringify(DEFAULT_USER_PERMISSIONS), inherits_id: null, created_at: now, updated_at: now },
  ]);
  //#endregion
}

export async function down(qi: QueryInterface): Promise<void> {
  for (const table of [
    "audit_logs", "schedules", "server_shares", "backups", "port_allocations", "game_servers", "definitions", "sources",
    "enrol_tokens", "host_grants", "hosts", "invites", "quotas", "user_roles", "users", "roles",
  ]) {
    await qi.dropTable(table);
  }
}
