import { Hono } from "hono";
import type { Transaction } from "sequelize";
import type { OkResponse } from "@shared/api/common.ts";
import type {
  CreateUserBody,
  EffectiveQuotaDto,
  PasswordLinkSentResponse,
  SetUserPasswordBody,
  UpdateQuotaBody,
  UpdateUserBody,
  UpdateUserResponse,
  UserDto,
} from "@shared/api/users.ts";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { ROLES } from "@shared/permissions.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Mailer } from "../mail/Mailer.ts";
import { MailTemplates } from "../mail/templates.ts";
import { AuditLog, EmailToken, GameServer, Quota, RecoveryCode, User } from "../models/index.ts";
import { AuthController } from "./AuthController.ts";

async function findUser(id: number, transaction?: Transaction): Promise<User> {
  const user = await User.findWithRoles({ id }, transaction);
  if (!user) throw HttpError.notFound("There is no user with that id.");
  return user;
}

/**
 * Non-admins with USERS_MANAGE may not touch an administrator's account in any way.
 */
function assertMayManage(actor: User, target: User): void {
  if (target.isAdmin() && !actor.isAdmin()) throw HttpError.forbidden("Only administrators can change or delete an administrator's account.");
}

function pushUserUpdated(userId: number): void {
  LiveGateway.push("user.updated", { userId }, { permission: "USERS_MANAGE", userIds: [userId] });
}

/**
 * `/api/users` (USERS_MANAGE). Pushes `user.updated` on every change; disabling a user or changing their roles bumps
 * `tokenVersion` (their sessions end). Non-admins can't change, reset or delete administrators, and can only grant
 * or remove roles whose permissions they hold (`User.assertMayAssignRoles`). Refuses to remove, disable or demote
 * the last admin (409), checked under `User.lockAdminChanges()`.
 * Audit: `user.created`, `user.updated`, `user.password_set`, `user.deleted`; M7: `user.welcome_failed`,
 * `user.password_link_sent`.
 */
export namespace UserController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ permissions: ["USERS_MANAGE"] }));

  /**
   * GET /api/users → UserDto[] (by username).
   */
  router.get("/", async (c) => {
    return c.json<UserDto[]>((await User.listWithRoles()).map((user) => user.toClientJSON()));
  });

  /**
   * POST /api/users  CreateUserBody → 201 UserDto. 403 for a role the caller may not grant, 409 when the username or
   * email is taken. M7: with an address and mail on, a welcome link (`PASSWORD_SETUP_TTL_HOURS`) is sent unless
   * `sendWelcomeEmail` is false; a failed send keeps the user (logged, audit `user.welcome_failed`). The password may
   * be left out only when that welcome email goes out (400 otherwise).
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateUserBody>(c);
    const actor = c.var.user;
    if (body.sendWelcomeEmail !== undefined && typeof body.sendWelcomeEmail !== "boolean") throw HttpError.badRequest("\"sendWelcomeEmail\" must be true or false.");
    const email = User.normalizeEmail(body.email);
    const sendWelcome = email !== null && Mailer.isEnabled() && body.sendWelcomeEmail !== false;
    const noPassword = body.password === undefined || body.password === null || body.password === "";
    if (noPassword && !sendWelcome) {
      throw HttpError.badRequest(email === null || !Mailer.isEnabled()
        ? "Give a password, or an email address for a \"set your password\" link (the panel must send email)."
        : "Give a password, or send the welcome email so they can set one.");
    }
    const roleNames = body.roles ?? [ROLES.USER];
    await actor.assertMayAssignRoles(await User.resolveRoles(roleNames));
    const user = await User.registerUser({
      username: body.username as string,
      password: noPassword ? null : body.password as string,
      email,
      displayName: body.displayName,
      roleNames,
      invitedById: actor.id,
    });
    await AuditLog.record({ action: "user.created", actorId: actor.id, ip: clientIp(c), details: { userId: user.id, username: user.username } });
    if (sendWelcome) {
      try {
        AuthController.takeEmailCooldown(user.id, "password");
        await Mailer.send(email, await AuthController.passwordLinkMessage(user, "welcome", email, actor.username));
      } catch (error) {
        AuthController.releaseEmailCooldown(user.id, "password");
        console.error(`welcome email to user ${user.id} failed`, error);
        await AuditLog.record({ action: "user.welcome_failed", actorId: actor.id, ip: clientIp(c), details: { userId: user.id, error: (error as Error).message } });
      }
    }
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON(), 201);
  });

  /**
   * PATCH /api/users/:id  UpdateUserBody → UpdateUserResponse. 403 (admin target or a role the caller may not grant
   * or remove), 404, 409 (last admin, email taken). Disabling or a role change signs the user out (live sockets close
   * with UNAUTHORIZED); when the caller changed their own roles, `token` carries their fresh session instead.
   */
  router.patch("/:id", async (c) => {
    const id = paramInt(c, "id");
    const body = await readBody<UpdateUserBody>(c);
    const actor = c.var.user;
    // Validate the body before taking the lock.
    const email = body.email === undefined ? undefined : User.normalizeEmail(body.email);
    const displayName = body.displayName === undefined ? undefined : User.normalizeDisplayName(body.displayName);
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") throw HttpError.badRequest("\"disabled\" must be true or false.");
    const newRoles = body.roles === undefined ? null : await User.resolveRoles(body.roles);

    const result = await User.sequelize!.transaction(async (transaction) => {
      await User.lockAdminChanges(transaction);
      const user = await findUser(id, transaction);
      assertMayManage(actor, user);
      const changes: string[] = [];

      // M7: a new address is unconfirmed, drops a pending change and turns email two-factor off.
      const emailChanged = email !== undefined && email !== user.email;
      if (emailChanged) {
        user.email = email;
        user.emailVerifiedAt = null;
        user.pendingEmail = null;
        changes.push("email");
        if (user.emailTwoFactor) {
          user.emailTwoFactor = false;
          changes.push("emailTwoFactor");
        }
      }
      if (displayName !== undefined && displayName !== user.displayName) {
        user.displayName = displayName;
        changes.push("displayName");
      }
      const disabled = body.disabled ?? user.disabled;
      if (disabled !== user.disabled) changes.push("disabled");

      const current = user.roles ?? [];
      const added = (newRoles ?? []).filter((role) => !current.some((r) => r.id === role.id));
      const removed = newRoles === null ? [] : current.filter((role) => !newRoles.some((r) => r.id === role.id));
      const rolesChanged = added.length > 0 || removed.length > 0;
      if (rolesChanged) {
        changes.push("roles");
        await actor.assertMayAssignRoles([...added, ...removed], transaction);
      }

      const staysAdmin = (newRoles ?? current).some((role) => role.isAdminRole()) && !disabled;
      if (user.isAdmin() && !user.disabled && !staysAdmin && await User.countActiveAdmins(transaction) <= 1) {
        throw HttpError.conflict("This is the last active administrator. Make someone else an administrator first.");
      }

      const disabledNow = changes.includes("disabled") && disabled;
      user.disabled = disabled;
      if (disabledNow || rolesChanged) user.tokenVersion += 1;
      try {
        await user.save({ transaction });
      } catch (error) {
        if ((error as Error).name === "SequelizeUniqueConstraintError") throw HttpError.conflict("That email address is already used by another account.");
        throw error;
      }
      if (rolesChanged) await user.setRoles(newRoles!, { transaction });
      if (emailChanged) {
        await EmailToken.revoke(id, ["confirm", "reset", "welcome", "login", "action"], transaction);
        if (changes.includes("emailTwoFactor") && !user.totpEnabled) await RecoveryCode.removeAll(id, transaction);
      }
      return { changes, rolesChanged, disabledNow, updated: await findUser(id, transaction) };
    });

    const { changes, rolesChanged, disabledNow, updated } = result;
    const newAddress = updated.email;
    if (changes.includes("email") && newAddress !== null) {
      AuthController.mailLater(id, "confirm", newAddress, () => AuthController.confirmLinkMessage(updated, newAddress));
    }
    const self = id === actor.id;
    if (changes.length) await AuditLog.record({ action: "user.updated", actorId: actor.id, ip: clientIp(c), details: { userId: id, changes } });
    if (disabledNow) LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your account was disabled.");
    // The caller's own tabs reconnect with the token returned below; anyone else signs in again with the new roles.
    else if (rolesChanged && self) LiveGateway.closeUser(id, LIVE_CLOSE.RECONNECT, "Your roles changed.");
    else if (rolesChanged) LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your roles changed. Sign in again.");
    pushUserUpdated(id);
    const token = rolesChanged && self && !disabledNow ? await updated.createToken() : null;
    return c.json<UpdateUserResponse>({ ...updated.toClientJSON(), token });
  });

  /**
   * POST /api/users/:id/password  SetUserPasswordBody → OkResponse. 403 for an admin target unless the caller is
   * an admin. Ends the user's sessions; M7: sends a "password changed" notice.
   */
  router.post("/:id/password", async (c) => {
    const id = paramInt(c, "id");
    const body = await readBody<SetUserPasswordBody>(c);
    const actor = c.var.user;
    const user = await findUser(id);
    assertMayManage(actor, user);
    User.verifyPassword(body.password);
    await user.setPassword(body.password);
    await User.sequelize!.transaction(async (transaction) => {
      await user.bumpTokenVersion(transaction);
      await EmailToken.revoke(id, ["reset", "welcome"], transaction);
    });
    await AuditLog.record({ action: "user.password_set", actorId: actor.id, ip: clientIp(c), details: { userId: id } });
    LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your password was changed by an administrator.");
    AuthController.notify(user, "passwordChanged", () => MailTemplates.passwordChanged({ username: user.username, by: "admin" }));
    pushUserUpdated(id);
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/users/:id/password-link → PasswordLinkSentResponse (M7). Emails a welcome link while the user has no
   * password yet, else a reset link. 403 for an admin target unless the caller is an admin; 409 without an address,
   * for a disabled account or while mail is off; 429 within the email cooldown; 502 when the relay refuses.
   */
  router.post("/:id/password-link", async (c) => {
    const id = paramInt(c, "id");
    const actor = c.var.user;
    const user = await findUser(id);
    assertMayManage(actor, user);
    const address = user.email;
    if (address === null) throw HttpError.conflict(`${user.username} has no email address. Add one first.`);
    if (user.disabled) throw HttpError.conflict(`${user.username}'s account is disabled. Enable it first.`);
    const kind = user.hasPassword ? "reset" : "welcome";
    await AuthController.mailNow(id, "password", address, () => AuthController.passwordLinkMessage(user, kind, address, actor.username));
    await AuditLog.record({ action: "user.password_link_sent", actorId: actor.id, ip: clientIp(c), details: { userId: id, kind } });
    return c.json<PasswordLinkSentResponse>({ kind, email: address });
  });

  /**
   * DELETE /api/users/:id → OkResponse. 403 for an admin target unless the caller is an admin. 409 when it's the
   * last admin, the caller, or the user still owns servers.
   */
  router.delete("/:id", async (c) => {
    const id = paramInt(c, "id");
    const actor = c.var.user;
    if (id === actor.id) throw HttpError.conflict("You can't delete your own account.");
    const user = await User.sequelize!.transaction(async (transaction) => {
      await User.lockAdminChanges(transaction);
      const user = await findUser(id, transaction);
      assertMayManage(actor, user);
      if (user.isAdmin() && !user.disabled && await User.countActiveAdmins(transaction) <= 1) {
        throw HttpError.conflict("This is the last active administrator and can't be deleted.");
      }
      const servers = await GameServer.count({ where: { ownerId: id }, transaction });
      if (servers > 0) throw HttpError.conflict(`${user.username} still owns ${servers} game server${servers === 1 ? "" : "s"}. Delete or transfer them first.`);
      await user.destroy({ transaction });
      return user;
    });
    LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your account was deleted.");
    await AuditLog.record({ action: "user.deleted", actorId: actor.id, ip: clientIp(c), details: { userId: id, username: user.username } });
    pushUserUpdated(id);
    return c.json<OkResponse>({ ok: true });
  });

  //#region Quota (M5)
  /**
   * GET /api/users/:id/quota → EffectiveQuotaDto.
   */
  router.get("/:id/quota", async (c) => {
    const id = paramInt(c, "id");
    return c.json<EffectiveQuotaDto>(await Quota.getEffective(id));
  });

  /**
   * PUT /api/users/:id/quota  UpdateQuotaBody → EffectiveQuotaDto. A field set to null falls back to the default.
   * 403 when a non-admin edits an admin's quota or their own. Audit `user.quota_changed`; live `quota.updated`.
   */
  router.put("/:id/quota", async (c) => {
    const id = paramInt(c, "id");
    const body = await readBody<UpdateQuotaBody>(c);
    const actor = c.var.user;
    const user = await findUser(id);
    assertMayManage(actor, user);
    if (id === actor.id && !actor.isAdmin()) throw HttpError.forbidden("You can't change your own quota. Ask an administrator.");
    const before = (await Quota.findOne({ where: { userId: id } }))?.toClientJSON() ?? null;
    const row = await Quota.setOverrides(id, body);
    await AuditLog.record({ action: "user.quota_changed", actorId: actor.id, ip: clientIp(c), details: { userId: id, before, after: row.toClientJSON() } });
    LiveGateway.push("quota.updated", { userId: id }, { permission: "USERS_MANAGE", userIds: [id] });
    return c.json<EffectiveQuotaDto>(await Quota.getEffective(id));
  });
  //#endregion
}

export default UserController;
