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
  UniqueConstraintError,
} from "sequelize";
import type { BelongsToManySetAssociationsMixin } from "sequelize";
import type { MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import bcrypt from "bcryptjs";
import { LIMITS, passwordBytes } from "@shared/constants.ts";
import type { UserDto } from "@shared/api/users.ts";
import { PERMISSION_KEYS, type Permission, ROLES } from "@shared/permissions.ts";
import { Config } from "../Config.ts";
import { type AppEnv, bearerToken } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ID, intFk } from "./columns.ts";
import { Role } from "./Role.ts";
import type { Quota } from "./Quota.ts";

const TOTP_CHALLENGE_SECONDS = 5 * 60;

/**
 * A panel account. Signs in with a password (bcrypt), gets a JWT bearer token, and optionally a TOTP second step (M5).
 */
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare username: string;
  declare email: string | null;
  declare displayName: string | null;
  declare password: string; // bcrypt hash. Never leaves the server.
  declare disabled: CreationOptional<boolean>;
  declare tokenVersion: CreationOptional<number>; // In every JWT; bumping it ends every session of the user.
  declare totpSecret: string | null; // Base32, set while enrolling 2FA and after (M5).
  declare totpEnabled: CreationOptional<boolean>;
  declare lastLoginAt: Date | null;
  declare invitedById: ForeignKey<User["id"]> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare roles?: NonAttribute<Role[]>;
  declare quota?: NonAttribute<Quota | null>;
  declare setRoles: BelongsToManySetAssociationsMixin<Role, number>;

  private _permissions: NonAttribute<Set<Permission> | null> = null; // Resolved with inheritance by `loadAccess()`.

  public static initModel(sequelize: Sequelize): void {
    User.init({
      id: ID,
      username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      email: { type: DataTypes.STRING(255), allowNull: true, unique: true },
      displayName: { type: DataTypes.STRING(64), allowNull: true },
      password: { type: DataTypes.STRING(255), allowNull: false },
      disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tokenVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      totpSecret: { type: DataTypes.STRING(64), allowNull: true },
      totpEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true },
      invitedById: intFk(true),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "users" });
  }

  //#region Validation
  /**
   * @throws HttpError 400 unless `username` matches `LIMITS.USERNAME_PATTERN`.
   */
  public static verifyUsername(username: unknown): asserts username is string {
    if (typeof username !== "string" || !LIMITS.USERNAME_PATTERN.test(username)) {
      throw HttpError.badRequest("The username must be 3-32 characters: letters, numbers, \"_\", \".\" or \"-\".");
    }
  }

  /**
   * @throws HttpError 400 unless `password` is a string of at least `LIMITS.PASSWORD_MIN` characters and at most
   * `LIMITS.PASSWORD_MAX_BYTES` bytes of UTF-8 (bcrypt ignores everything after 72 bytes).
   */
  public static verifyPassword(password: unknown): asserts password is string {
    if (typeof password !== "string" || password.length < LIMITS.PASSWORD_MIN) {
      throw HttpError.badRequest(`The password must be at least ${LIMITS.PASSWORD_MIN} characters long.`);
    }
    if (passwordBytes(password) > LIMITS.PASSWORD_MAX_BYTES) {
      throw HttpError.badRequest(`The password can be at most ${LIMITS.PASSWORD_MAX_BYTES} bytes long (${LIMITS.PASSWORD_MAX_BYTES} plain letters or digits; accented letters and emoji take 2-4 bytes each).`);
    }
  }

  /**
   * @returns The trimmed, lowercased address, or null for an empty value.
   * @throws HttpError 400 when the value is not a plausible email address.
   */
  public static normalizeEmail(email: unknown): string | null {
    if (email === null || email === undefined) return null;
    if (typeof email !== "string") throw HttpError.badRequest("The email address must be a string.");
    const value = email.trim().toLowerCase();
    if (value === "") return null;
    if (value.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw HttpError.badRequest("That doesn't look like an email address.");
    return value;
  }

  /**
   * @returns The trimmed display name (max 64 characters), or null for an empty value.
   */
  public static normalizeDisplayName(displayName: unknown): string | null {
    if (displayName === null || displayName === undefined) return null;
    if (typeof displayName !== "string") throw HttpError.badRequest("The display name must be a string.");
    const value = displayName.trim();
    if (value.length > 64) throw HttpError.badRequest("The display name can be at most 64 characters long.");
    return value === "" ? null : value;
  }
  //#endregion

  //#region Factories and finders
  /**
   * Validate and create a user with the given roles (default `user`). 409 when the username or email is taken.
   */
  public static async registerUser(data: User.RegisterData, transaction?: Transaction): Promise<User> {
    User.verifyUsername(data.username);
    User.verifyPassword(data.password);
    const email = User.normalizeEmail(data.email);
    const displayName = User.normalizeDisplayName(data.displayName);
    const roles = await User.resolveRoles(data.roleNames ?? [ROLES.USER], transaction);

    if (await User.findOne({ where: { username: data.username }, transaction })) {
      throw HttpError.conflict(`The username "${data.username}" is already taken.`);
    }
    if (email !== null && await User.findOne({ where: { email }, transaction })) {
      throw HttpError.conflict(`The email address ${email} is already used by another account.`);
    }

    const create = async (t: Transaction): Promise<User> => {
      const user = User.build({ username: data.username, email, displayName, password: "", totpSecret: null, lastLoginAt: null, invitedById: data.invitedById ?? null });
      await user.setPassword(data.password);
      try {
        await user.save({ transaction: t });
      } catch (error) {
        if (error instanceof UniqueConstraintError) throw HttpError.conflict("That username or email address is already taken.");
        throw error;
      }
      await user.setRoles(roles, { transaction: t });
      return user;
    };
    const user = transaction ? await create(transaction) : await User.sequelize!.transaction(create);
    return (await User.findWithRoles({ id: user.id }, transaction))!;
  }

  /**
   * The roles for a list of names, in the same order.
   * @throws HttpError 400 when a name is unknown or the list is empty.
   */
  public static async resolveRoles(names: unknown, transaction?: Transaction): Promise<Role[]> {
    if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string")) {
      throw HttpError.badRequest("Give at least one role name.");
    }
    const unique = [...new Set(names as string[])];
    const roles = await Role.findAll({ where: { name: unique }, transaction });
    const missing = unique.filter((name) => !roles.some((r) => r.name === name));
    if (missing.length) throw HttpError.badRequest(`Unknown role${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
    return unique.map((name) => roles.find((r) => r.name === name)!);
  }

  /**
   * A user matching `where` with `roles` loaded and permissions resolved (see `loadAccess()`), or null.
   */
  public static async findWithRoles(where: { id?: number; username?: string }, transaction?: Transaction): Promise<User | null> {
    const user = await User.findOne({ where, include: [{ association: "roles" }], transaction });
    await user?.loadAccess(transaction);
    return user;
  }

  /**
   * Every user by username, with roles loaded and permissions resolved.
   */
  public static async listWithRoles(): Promise<User[]> {
    const users = await User.findAll({ include: [{ association: "roles" }], order: [["username", "ASC"]] });
    await Promise.all(users.map((user) => user.loadAccess()));
    return users;
  }

  /**
   * Enabled users holding the `admin` role. Used to refuse removing the last one.
   */
  public static async countActiveAdmins(transaction?: Transaction): Promise<number> {
    return await User.count({
      where: { disabled: false },
      include: [{ association: "roles", where: { name: ROLES.ADMIN }, required: true }],
      distinct: true,
      transaction,
    });
  }

  /**
   * Serialize changes that could remove an administrator (or create the first one): locks the `admin` role row
   * (`SELECT … FOR UPDATE`) until `transaction` ends. Call it as the transaction's first statement, so the reads that
   * follow (InnoDB's snapshot starts at the first plain read) see what a previous holder committed. SQLite ignores
   * the lock but serializes write transactions itself.
   */
  public static async lockAdminChanges(transaction: Transaction): Promise<void> {
    await Role.findOne({ where: { name: ROLES.ADMIN }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
  }

  /**
   * The user for a username and password, or null when either is wrong or the account is disabled.
   * Loads `roles` (with inheritance) so permission checks work on the result.
   */
  public static async authenticateUser(username: string, password: string): Promise<User | null> {
    if (typeof username !== "string" || typeof password !== "string") return null;
    const user = await User.findWithRoles({ username });
    // Compare even for an unknown user so the response time doesn't reveal which usernames exist.
    const passwordOk = user ? await user.checkPassword(password) : await bcrypt.compare(password, await User.getDummyHash());
    if (!user || !passwordOk || user.disabled) return null;
    return user;
  }

  // A hash of a random string, for the constant-time miss path in `authenticateUser`.
  private static _dummyHash: Promise<string> | null = null;

  private static getDummyHash(): Promise<string> {
    return User._dummyHash ??= bcrypt.hash(crypto.randomUUID(), 12);
  }

  /**
   * The user a session JWT belongs to, or null when the token is invalid, expired, of another purpose, of an old
   * `tokenVersion`, or the user is disabled. Loads `roles`.
   */
  public static async findByToken(token: string): Promise<User | null> {
    let payload: User.TokenPayload;
    try {
      payload = await verify(token, Config.JWT_SECRET, "HS256") as User.TokenPayload;
    } catch {
      return null;
    }
    if (payload.purpose !== "session" || typeof payload.sub !== "number") return null;
    const user = await User.findWithRoles({ id: payload.sub });
    if (!user || user.disabled || user.tokenVersion !== payload.ver) return null;
    return user;
  }

  /**
   * Whether any user exists (first-run setup is offered while none does).
   */
  public static async hasAnyUser(transaction?: Transaction): Promise<boolean> {
    return (await User.count({ transaction })) > 0;
  }
  //#endregion

  //#region Password and tokens
  /**
   * Hash and set a new password. Does not save.
   */
  public async setPassword(password: string): Promise<void> {
    this.password = await bcrypt.hash(password, 12);
  }

  public async checkPassword(password: string): Promise<boolean> {
    return await bcrypt.compare(password, this.password);
  }

  /**
   * A signed JWT (`JWT_SECRET`, HS256) for this user.
   * @param purpose `session` (default, `JWT_TTL_HOURS`) or `totp` (a 5-minute login challenge).
   */
  public async createToken(purpose: User.TokenPurpose = "session"): Promise<string> {
    const seconds = purpose === "totp" ? TOTP_CHALLENGE_SECONDS : Config.JWT_TTL_HOURS * 3600;
    const payload: User.TokenPayload = {
      sub: this.id,
      ver: this.tokenVersion,
      purpose,
      exp: Math.floor(Date.now() / 1000) + seconds,
    };
    return await sign(payload, Config.JWT_SECRET, "HS256");
  }

  /**
   * Invalidate every session of this user (JWTs carry the old version). Saves.
   */
  public async bumpTokenVersion(transaction?: Transaction): Promise<void> {
    this.tokenVersion += 1;
    await this.save({ transaction });
  }
  //#endregion

  //#region Permissions
  /**
   * Whether the user has the `admin` role, which passes every permission check. Needs `roles` loaded.
   */
  public isAdmin(): boolean {
    return this.roles?.some((role) => role.isAdminRole()) ?? false;
  }

  /**
   * Resolve permissions through role inheritance (async: it walks `inheritsId`). Call after loading `roles`;
   * the finders above do it already.
   */
  public async loadAccess(transaction?: Transaction): Promise<void> {
    const permissions = new Set<Permission>();
    for (const role of this.roles ?? []) {
      for (const permission of await role.resolvePermissions(transaction)) permissions.add(permission);
    }
    this._permissions = permissions;
  }

  /**
   * Effective permissions from every role and the roles they inherit. Admins get every key. Needs `roles` loaded.
   */
  public getPermissions(): Set<Permission> {
    if (this.isAdmin()) return new Set(PERMISSION_KEYS);
    // Without `loadAccess()` only the roles' own keys are known.
    return this._permissions ?? new Set(this.roles?.flatMap((role) => role.permissions) ?? []);
  }

  public hasPermission(permission: Permission): boolean {
    return this.isAdmin() || this.getPermissions().has(permission);
  }

  /**
   * Refuse to let this user hand out or take away `roles` unless they hold every permission those roles grant
   * (inheritance included). Admins may assign any role; nobody else may assign `admin`.
   * @throws HttpError 403 naming the role and the missing permissions.
   */
  public async assertMayAssignRoles(roles: Role[], transaction?: Transaction): Promise<void> {
    if (this.isAdmin()) return;
    const own = this.getPermissions();
    for (const role of roles) {
      if (role.isAdminRole()) throw HttpError.forbidden("Only administrators can grant or remove the admin role.");
      const missing = [...await role.resolvePermissions(transaction)].filter((permission) => !own.has(permission));
      if (missing.length) {
        throw HttpError.forbidden(`You can't grant or remove the role "${role.name}": it carries ${missing.join(", ")}, which you don't have yourself.`);
      }
    }
  }
  //#endregion

  //#region Serializers
  /**
   * Public-safe shape (other users' lists, audit entries).
   */
  public toPublicJSON(): { id: number; username: string; displayName: string | null } {
    return { id: this.id, username: this.username, displayName: this.displayName };
  }

  /**
   * The full DTO for the user themself and for admins. Needs `roles` loaded.
   */
  public toClientJSON(): UserDto {
    return {
      id: this.id,
      username: this.username,
      email: this.email,
      displayName: this.displayName,
      disabled: this.disabled,
      roles: (this.roles ?? []).map((role) => role.name),
      permissions: [...this.getPermissions()],
      isAdmin: this.isAdmin(),
      totpEnabled: this.totpEnabled,
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
    };
  }
  //#endregion

  /**
   * Route guard. Reads `Authorization: Bearer <token>`, resolves it with `findByToken`, sets `c.var.user`.
   * `required` (default true): 401 without a valid token. `admin`: 403 unless admin. `permissions`: 403 unless the
   * user has every listed key (admins always pass). A user an outer guard already set is reused (routers mounted below
   * `/servers` run `ServerController`'s guard too), so the token is looked up once per request.
   */
  public static $middleware(opts?: User.MiddlewareOptions): MiddlewareHandler<AppEnv> {
    opts ??= {};
    const required = opts.required ?? true;
    return async (c, next) => {
      const token = bearerToken(c);
      const user = (c.get("user") as User | undefined) ?? (token ? await User.findByToken(token) : null);
      if (!user) {
        if (required) throw HttpError.unauthorized();
        return await next();
      }
      c.set("user", user);
      if (opts.admin && !user.isAdmin()) throw HttpError.forbidden("Only administrators can do that.");
      if (opts.permissions?.some((permission) => !user.hasPermission(permission))) throw HttpError.forbidden();
      await next();
    };
  }
}

export namespace User {
  export type TokenPurpose = "session" | "totp";

  /**
   * Claims of a panel JWT.
   */
  export interface TokenPayload {
    sub: number; // User id.
    ver: number; // `tokenVersion` at signing time.
    purpose: TokenPurpose;
    exp: number; // Unix seconds.
    [key: string]: unknown;
  }

  export interface RegisterData {
    username: string;
    password: string;
    email?: string | null;
    displayName?: string | null;
    roleNames?: string[]; // Default: [ROLES.USER].
    invitedById?: number | null;
  }

  export interface MiddlewareOptions {
    required?: boolean;
    admin?: boolean;
    permissions?: Permission[];
  }
}

export type UserAttributes = InferAttributes<User>;
export default User;
