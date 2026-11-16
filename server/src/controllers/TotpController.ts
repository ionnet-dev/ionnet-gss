import { Hono } from "hono";
import type { RecoveryCodesBody, RecoveryCodesResponse, TotpConfirmBody, TotpConfirmResponse, TotpDisableBody, TotpSetupBody, TotpSetupResponse, TotpStatusResponse } from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody, readOptionalBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { generateSecret, otpauthUrl, verifyCode } from "../lib/totp.ts";
import { Mailer } from "../mail/Mailer.ts";
import { MailTemplates } from "../mail/templates.ts";
import { AuditLog, EmailToken, RecoveryCode, User } from "../models/index.ts";
import { AuthController } from "./AuthController.ts";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pushUserUpdated(userId: number): void {
  LiveGateway.push("user.updated", { userId }, { permission: "USERS_MANAGE", userIds: [userId] });
}

/**
 * Why email two-factor can't be turned on now, or null when it can (M7).
 */
function emailUnavailableReason(user: User): string | null {
  if (!Mailer.isEnabled()) return "The panel doesn't send email.";
  if (!user.isEmailConfirmed()) return "Confirm your email address first.";
  return null;
}

/**
 * Two-factor sign-in (M5). `router` is the caller's own setup at `/api/auth/totp`; `adminRouter` is the admin reset
 * at `/api/users/:id/totp` (M7: clears both methods). The login second step (`POST /api/auth/login/totp`) stays in
 * `AuthController`, email two-factor is in `EmailController`. Contracts: STRUCTURE.md "M5: tenancy" (TOTP) and
 * "M7: email". Proofs go through `AuthController.assertSecondProof`; wrong passwords or codes count in the per-user
 * failure limiter.
 * Audit: `user.totp_enabled`, `user.totp_disabled`, `user.recovery_codes_issued`, `user.totp_reset`; each pushes
 * `user.updated`.
 */
export namespace TotpController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/auth/totp → TotpStatusResponse (M7: with the email method's state).
   */
  router.get("/", async (c) => {
    const user = c.var.user;
    const reason = user.emailTwoFactor ? null : emailUnavailableReason(user);
    return c.json<TotpStatusResponse>({
      enabled: user.totpEnabled,
      pending: !user.totpEnabled && user.totpSecret !== null,
      recoveryCodesLeft: user.hasSecondFactor() ? await RecoveryCode.countLeft(user.id) : 0,
      emailEnabled: user.emailTwoFactor,
      emailAvailable: !user.emailTwoFactor && reason === null,
      emailUnavailableReason: reason,
    });
  });

  /**
   * POST /api/auth/totp/setup  TotpSetupBody → TotpSetupResponse. Stores a pending secret (`totpEnabled` stays false;
   * a pending one is replaced). 409 while TOTP is on. M7: while email two-factor is on, adding a factor needs its
   * proof (password + an `action` email code or a recovery code; 401); the body is empty otherwise.
   */
  router.post("/setup", async (c) => {
    const user = c.var.user;
    if (user.totpEnabled) throw HttpError.conflict("Two-factor sign-in is already on. Turn two-factor sign-in off first.");
    if (user.emailTwoFactor) await AuthController.assertSecondProof(c, user, await readOptionalBody<TotpSetupBody>(c));
    const secret = generateSecret();
    // Conditional, so a setup racing a confirm can't swap the secret under an enabled account.
    const [affected] = await User.update({ totpSecret: secret, totpLastStep: null }, { where: { id: user.id, totpEnabled: false } });
    if (affected !== 1) throw HttpError.conflict("Two-factor sign-in is already on. Turn two-factor sign-in off first.");
    return c.json<TotpSetupResponse>({ secret, otpauthUrl: otpauthUrl(secret, user.username) });
  });

  /**
   * POST /api/auth/totp/confirm  TotpConfirmBody → TotpConfirmResponse. Turns two-factor on when the code matches the
   * pending secret and issues the recovery codes, unless email two-factor was already on (M7: its codes stay,
   * `recoveryCodes` null). Sends a "two-factor turned on" notice. 400 wrong code, 409 no pending setup.
   */
  router.post("/confirm", async (c) => {
    const body = await readBody<TotpConfirmBody>(c);
    const user = c.var.user;
    if (user.totpEnabled) throw HttpError.conflict("Two-factor sign-in is already on.");
    const secret = user.totpSecret;
    if (!secret) throw HttpError.conflict("Start the two-factor setup first.");
    const step = await verifyCode(secret, asString(body.code).replace(/\s/g, ""), null);
    if (step === null) throw HttpError.badRequest("That code doesn't match. Check the time on your phone and enter the current code.");

    const recoveryCodes = await User.sequelize!.transaction(async (transaction) => {
      // Only the secret this code was checked against may be turned on (a newer setup replaces it).
      const [affected] = await User.update({ totpEnabled: true, totpLastStep: step }, { where: { id: user.id, totpEnabled: false, totpSecret: secret }, transaction });
      if (affected !== 1) throw HttpError.conflict("The setup changed in the meantime. Start it again.");
      if (user.emailTwoFactor) return null;
      return await RecoveryCode.issue(user.id, transaction);
    });
    // Not dirty: the row already holds these values.
    user.setDataValue("totpEnabled", true);
    user.setDataValue("totpLastStep", step);
    AuthController.notify(user, "twoFactorOn:totp", () => MailTemplates.twoFactorOn({ username: user.username, method: "totp" }));
    await AuditLog.record({ action: "user.totp_enabled", actorId: user.id, ip: clientIp(c) });
    pushUserUpdated(user.id);
    return c.json<TotpConfirmResponse>({ user: user.toClientJSON(), recoveryCodes });
  });

  /**
   * POST /api/auth/totp/disable  TotpDisableBody → UserDto. Needs the password and a current code (either method,
   * M7) or a recovery code (401). 409 while TOTP is off. Ends no sessions; sends a "two-factor turned off" notice.
   */
  router.post("/disable", async (c) => {
    const body = await readBody<TotpDisableBody>(c);
    const user = c.var.user;
    if (!user.totpEnabled) throw HttpError.conflict("Two-factor sign-in is already off.");
    const method = await AuthController.assertSecondProof(c, user, body);
    await user.clearTotp();
    AuthController.notify(user, "twoFactorOff:totp", () => MailTemplates.twoFactorOff({ username: user.username, method: "totp", admin: false }));
    await AuditLog.record({ action: "user.totp_disabled", actorId: user.id, ip: clientIp(c), details: { method } });
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON());
  });

  /**
   * POST /api/auth/totp/recovery-codes  RecoveryCodesBody → RecoveryCodesResponse. Replaces every code; same proof
   * as disabling. 409 while no second factor is on.
   */
  router.post("/recovery-codes", async (c) => {
    const body = await readBody<RecoveryCodesBody>(c);
    const user = c.var.user;
    if (!user.hasSecondFactor()) throw HttpError.conflict("Turn two-factor sign-in on first.");
    const method = await AuthController.assertSecondProof(c, user, body);
    const recoveryCodes = await RecoveryCode.issue(user.id);
    await AuditLog.record({ action: "user.recovery_codes_issued", actorId: user.id, ip: clientIp(c), details: { method } });
    pushUserUpdated(user.id);
    return c.json<RecoveryCodesResponse>({ recoveryCodes });
  });

  export const adminRouter = new Hono<AppEnv>();

  adminRouter.use("*", User.$middleware({ permissions: ["USERS_MANAGE"] }));

  /**
   * POST /api/users/:id/totp/reset → UserDto. USERS_MANAGE; 403 for an admin target unless the caller is an admin.
   * Clears both second factors (TOTP and, M7, email) and the recovery codes and bumps `tokenVersion` (the user's
   * sessions end). Sends a "two-factor turned off" notice when one was on.
   */
  adminRouter.post("/reset", async (c) => {
    const id = paramInt(c, "id");
    const actor = c.var.user;
    const target = await User.findWithRoles({ id });
    if (!target) throw HttpError.notFound("That user doesn't exist.");
    if (target.isAdmin() && !actor.isAdmin()) throw HttpError.forbidden("Only administrators can reset an administrator's two-factor sign-in.");
    const hadSecondFactor = target.hasSecondFactor();
    await User.sequelize!.transaction(async (transaction) => {
      target.emailTwoFactor = false;
      await target.clearTotp(transaction);
      await EmailToken.revoke(id, ["login", "action"], transaction);
      await RecoveryCode.removeAll(id, transaction);
      await target.bumpTokenVersion(transaction);
    });
    if (hadSecondFactor) {
      AuthController.notify(target, "twoFactorOff:admin", () => MailTemplates.twoFactorOff({ username: target.username, method: "all", admin: true }));
    }
    await AuditLog.record({ action: "user.totp_reset", actorId: actor.id, ip: clientIp(c), details: { userId: id, username: target.username } });
    LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your two-factor sign-in was reset by an administrator. Sign in again.");
    pushUserUpdated(id);
    return c.json<UserDto>(target.toClientJSON());
  });
}

export default TotpController;
