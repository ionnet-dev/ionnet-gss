import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  Op,
  type Sequelize,
  Transaction,
} from "sequelize";
import type { EffectiveQuotaDto, QuotaDto, UpdateQuotaBody } from "@shared/api/users.ts";
import { Config } from "../Config.ts";
import { DefinitionEngine } from "../definitions/DefinitionEngine.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Backup } from "./Backup.ts";
import { ID, intFk } from "./columns.ts";
import { GameServer } from "./GameServer.ts";
import { User } from "./User.ts";

type Usage = EffectiveQuotaDto["used"];

/**
 * Largest value a quota field takes (the columns are INTEGER).
 */
const MAX_QUOTA_VALUE = 2147483647;

/**
 * Each quota field: its usage key, its column, and its default.
 */
const FIELDS: { used: keyof Usage; limit: keyof QuotaDto; fallback: () => number }[] = [
  { used: "servers", limit: "maxServers", fallback: () => Config.DEFAULT_QUOTA_SERVERS },
  { used: "memoryMb", limit: "maxMemoryMb", fallback: () => Config.DEFAULT_QUOTA_MEMORY_MB },
  { used: "cpuMillis", limit: "maxCpuMillis", fallback: () => Config.DEFAULT_QUOTA_CPU_MILLIS },
  { used: "diskMb", limit: "maxDiskMb", fallback: () => Config.DEFAULT_QUOTA_DISK_MB },
  { used: "backups", limit: "maxBackups", fallback: () => Config.DEFAULT_QUOTA_BACKUPS },
];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function cpus(millis: number): string {
  const value = Number((millis / 1000).toFixed(3));
  return `${value} CPU${value === 1 ? "" : "s"}`;
}

/**
 * The 409 message for a field that doesn't fit.
 * @param own The caller is the owner ("your quota"), else "the owner's quota".
 */
function refusal(field: keyof Usage, used: number, total: number, limit: number, own: boolean): string {
  const whose = own ? "your" : "the owner's";
  switch (field) {
    case "servers":
      return own
        ? `You already have ${plural(used, "game server")}, the most your quota allows (${limit}).`
        : `The owner already has ${plural(used, "game server")}, the most the owner's quota allows (${limit}).`;
    case "memoryMb":
      return `This would use ${total} MB of RAM; ${whose} quota is ${limit} MB.`;
    case "cpuMillis":
      return `This would use ${cpus(total)}; ${whose} quota is ${cpus(limit)}.`;
    case "diskMb":
      return `This would use ${total} MB of disk space; ${whose} quota is ${limit} MB.`;
    case "backups":
      return `${own ? "Your" : "The owner's"} servers already have ${plural(used, "backup")}, the most ${whose} quota allows (${limit}). Delete an old one first.`;
  }
}

/**
 * Per-user limits. Every field `null` = use the panel default (`DEFAULT_QUOTA_*`). A user without a row uses every
 * default. Admins have no quota. Checked at server create, at every change of a bound limit (settings, upgrade) and
 * at backup create, against the owner's usage (M5; contracts in STRUCTURE.md "M5: tenancy").
 */
export class Quota extends Model<InferAttributes<Quota>, InferCreationAttributes<Quota>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User["id"]>;
  declare maxServers: number | null; // null = DEFAULT_QUOTA_SERVERS
  declare maxMemoryMb: number | null; // null = DEFAULT_QUOTA_MEMORY_MB
  declare maxCpuMillis: number | null; // null = DEFAULT_QUOTA_CPU_MILLIS (1000 = one CPU)
  declare maxDiskMb: number | null; // null = DEFAULT_QUOTA_DISK_MB
  declare maxBackups: number | null; // null = DEFAULT_QUOTA_BACKUPS
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    Quota.init({
      id: ID,
      userId: { ...intFk(false), unique: true },
      maxServers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxMemoryMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxCpuMillis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxDiskMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxBackups: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "quotas" });
  }

  /**
   * The user's limits with defaults applied (`Config.DEFAULT_QUOTA_*` where a field is null or there is no row), their
   * current usage (`getUsage`), and whether they are exempt (admins).
   * @throws HttpError 404 when the user doesn't exist.
   */
  public static async getEffective(userId: number, transaction?: Transaction): Promise<EffectiveQuotaDto> {
    const user = await User.findWithRoles({ id: userId }, transaction);
    if (!user) throw HttpError.notFound("There is no user with that id.");
    const row = await Quota.findOne({ where: { userId }, transaction });
    return {
      userId,
      exempt: user.isAdmin(),
      limits: Quota.limitsOf(row),
      used: await Quota.getUsage(userId, transaction),
      overrides: row?.toClientJSON() ?? { maxServers: null, maxMemoryMb: null, maxCpuMillis: null, maxDiskMb: null, maxBackups: null },
    };
  }

  /**
   * The limits a row (or no row) gives, with `Config.DEFAULT_QUOTA_*` where a field is null.
   */
  public static limitsOf(row: Quota | null): EffectiveQuotaDto["limits"] {
    const limits = {} as EffectiveQuotaDto["limits"];
    for (const field of FIELDS) limits[field.limit] = row?.[field.limit] ?? field.fallback();
    return limits;
  }

  /**
   * What the user uses now, over their own servers whose state isn't `deleting`: server count, memory and CPU (game
   * limits plus `DefinitionEngine.serviceTotals` of each server's definition), disk (sum of `diskMb`), and backups
   * that aren't `failed`.
   */
  public static async getUsage(userId: number, transaction?: Transaction): Promise<Usage> {
    const servers = await GameServer.findAll({
      where: { ownerId: userId, state: { [Op.ne]: "deleting" } },
      attributes: ["id", "memoryMb", "cpuMillis", "diskMb"],
      include: [{ association: "definition", attributes: ["id", "document"] }],
      transaction,
    });
    const used: Usage = { servers: servers.length, memoryMb: 0, cpuMillis: 0, diskMb: 0, backups: 0 };
    for (const server of servers) {
      const services = server.definition ? DefinitionEngine.serviceTotals(server.definition.document) : { memoryMb: 0, cpuMillis: 0 };
      const held = Quota._held.get(server.id);
      used.memoryMb += server.memoryMb + services.memoryMb + (held?.memoryMb ?? 0);
      used.cpuMillis += server.cpuMillis + services.cpuMillis + (held?.cpuMillis ?? 0);
      used.diskMb += server.diskMb;
    }
    if (servers.length) {
      used.backups = await Backup.count({ where: { serverId: servers.map((server) => server.id), status: { [Op.ne]: "failed" } }, transaction });
    }
    return used;
  }

  /**
   * Usage that changes in progress hold on top of what their server's row shows, by server id. An upgrade to a
   * definition with bigger stack services keeps the old definition on the row until the agent has the new spec, so
   * the difference is held here meanwhile. One panel process, so memory is enough.
   */
  private static readonly _held = new Map<string, { memoryMb: number; cpuMillis: number }>();

  /**
   * Count `extra` for the server on top of its row until `release`. Call it inside the transaction that ran
   * `assertFits`, so the next check for the owner (which waits for that transaction) sees it.
   */
  public static hold(serverId: string, extra: { memoryMb: number; cpuMillis: number }): void {
    Quota._held.set(serverId, extra);
  }

  /**
   * Stop counting what `hold` added, once the row shows the change (or the change was given up).
   */
  public static release(serverId: string): void {
    Quota._held.delete(serverId);
  }

  /**
   * What `hold` counts for the server right now (host capacity adds it too), or undefined.
   */
  public static heldFor(serverId: string): { memoryMb: number; cpuMillis: number } | undefined {
    return Quota._held.get(serverId);
  }

  /**
   * Refuse a change that would take the owner past their quota (admins pass). Locks the user's row first
   * (`SELECT … FOR UPDATE`), so concurrent checks for one user take turns; call it inside the transaction that also
   * writes the change (row insert, new limits), before any host row lock (order: user, then host). Only the fields in
   * `delta` are checked, and only growth: a quota lowered below the current usage blocks growth, nothing else.
   * @param delta What the change adds.
   * Run it in a `Quota.transaction` (READ COMMITTED), as its first statement: see there why.
   * @param delta What the change adds.
   * @param transaction Required in practice: the transaction that also writes the change.
   * @param opts `actorId`: the caller, when it isn't the owner (the message then says "the owner's quota"; their row
   * is locked too, in id order with the owner's).
   * @throws HttpError 409 naming the limit, e.g. "This would use 6144 MB of RAM; your quota is 4096 MB."
   * @throws Error without a transaction (the check would not be atomic with the write).
   */
  public static async assertFits(userId: number, delta: Quota.Delta, transaction?: Transaction, opts?: { actorId?: number }): Promise<void> {
    if (!transaction) throw new Error("Quota.assertFits needs the transaction that writes the change, so the check and the write are atomic.");
    // Plain row locks, no joins: locking the role tables too would invert `User.lockAdminChanges` (roles, then users).
    // A caller other than the owner is locked too, both in ascending id order: an insert in this transaction that
    // references the caller (`backups.created_by_id`) takes a shared lock on their row through the foreign key, and
    // taking it there, after the owner's lock, deadlocks against a transaction that holds the caller's row as owner.
    const ids = [...new Set([userId, opts?.actorId ?? userId])].sort((a, b) => a - b);
    for (const id of ids) {
      const locked = await User.findByPk(id, { attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
      if (!locked && id === userId) throw HttpError.notFound("There is no user with that id.");
    }
    const checked = FIELDS.filter((field) => (delta[field.used] ?? 0) > 0);
    if (checked.length === 0) return;
    const owner = await User.findWithRoles({ id: userId }, transaction);
    if (!owner || owner.isAdmin()) return;
    const limits = Quota.limitsOf(await Quota.findOne({ where: { userId }, transaction }));
    const used = await Quota.getUsage(userId, transaction);
    const own = opts?.actorId === undefined || opts.actorId === userId;
    for (const field of checked) {
      const total = used[field.used] + delta[field.used]!;
      const limit = limits[field.limit];
      if (total > limit) throw HttpError.conflict(refusal(field.used, used[field.used], total, limit, own));
    }
  }

  /**
   * Run `fn` in a READ COMMITTED transaction, the isolation every `assertFits` caller uses. Under the default
   * REPEATABLE READ the snapshot starts at the first plain read, which is `assertFits`' usage sum: the reads after a
   * later host lock (capacity, free ports) would then miss rows another user's create committed while this one waited
   * for that lock. With READ COMMITTED each read sees what is committed when it runs, so it is current under every
   * lock held by then.
   */
  public static async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await Quota.sequelize!.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, fn);
  }

  /**
   * Store new overrides (absent = unchanged, null = default), creating the row on first use. Locks the user's row
   * first, like `assertFits`.
   * @throws HttpError 400 for a value that isn't a whole number 0 … 2^31-1 or null, or an unknown field.
   * @throws HttpError 404 when the user doesn't exist.
   */
  public static async setOverrides(userId: number, body: UpdateQuotaBody, transaction?: Transaction): Promise<Quota> {
    if (!transaction) return await Quota.transaction((t) => Quota.setOverrides(userId, body, t));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw HttpError.badRequest("The body must be an object of quota fields.");
    const keys = FIELDS.map((field) => field.limit);
    const changes: Partial<QuotaDto> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!keys.includes(key as keyof QuotaDto)) throw HttpError.badRequest(`"${key}" isn't a quota field. Use ${keys.map((name) => `"${name}"`).join(", ")}.`);
      if (value === undefined) continue;
      if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_QUOTA_VALUE)) {
        throw HttpError.badRequest(`"${key}" must be a whole number from 0 to ${MAX_QUOTA_VALUE}, or null for the panel default.`);
      }
      changes[key as keyof QuotaDto] = value;
    }
    const locked = await User.findByPk(userId, { attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
    if (!locked) throw HttpError.notFound("There is no user with that id.");
    const row = await Quota.findOne({ where: { userId }, lock: transaction.LOCK.UPDATE, transaction });
    if (row) {
      row.set(changes);
      await row.save({ transaction });
      return row;
    }
    return await Quota.create({ userId, maxServers: null, maxMemoryMb: null, maxCpuMillis: null, maxDiskMb: null, maxBackups: null, ...changes }, { transaction });
  }

  public toClientJSON(): QuotaDto {
    return {
      maxServers: this.maxServers,
      maxMemoryMb: this.maxMemoryMb,
      maxCpuMillis: this.maxCpuMillis,
      maxDiskMb: this.maxDiskMb,
      maxBackups: this.maxBackups,
    };
  }
}

export namespace Quota {
  /**
   * What a change adds to a user's usage. Omitted fields aren't checked.
   */
  export interface Delta {
    servers?: number;
    memoryMb?: number; // Game plus stack services.
    cpuMillis?: number; // Game plus stack services; 1000 = one CPU.
    diskMb?: number;
    backups?: number;
  }
}

export type QuotaAttributes = InferAttributes<Quota>;
export default Quota;
