import { type Context, Hono } from "hono";
import type { RecoveryCodesBody, RecoveryCodesResponse, TotpConfirmBody, TotpConfirmResponse, TotpDisableBody, TotpSetupResponse, TotpStatusResponse } from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { generateSecret, otpauthUrl, verifyCode } from "../lib/totp.ts";
import { AuditLog, RecoveryCode, User } from "../models/index.ts";
import { AuthController } from "./AuthController.ts";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pushUserUpdated(userId: number): void {
  LiveGateway.push("user.updated", { userId }, { permission: "USERS_MANAGE", userIds: [userId] });
}

/**
 * The proof disabling and new recovery codes need: the password, then a current code or a recovery code (used up).
 * Every attempt counts in the per-user second-factor limiter; the password is checked first, so a wrong password
 * never uses up a code or a time step.
 * @throws HttpError 401 when either is wrong, 429 at the limit.
 */
async function assertSecondProof(c: Context<AppEnv>, user: User, body: Partial<TotpDisableBody>): Promise<"totp" | "recovery_code"> {
  AuthController.hitSecondFactor(user.id);
  const passwordOk = await user.checkPassword(asString(body.password));
  const method = passwordOk ? await user.consumeSecondFactor(asString(body.code)) : null;
  if (!passwordOk || !method) {
    await AuditLog.record({ action: "user.login_failed", actorId: user.id, ip: clientIp(c), details: { username: user.username, stage: "totp" } });
    throw HttpError.unauthorized(passwordOk ? "The code is wrong or was already used." : "The password is wrong.");
  }
  AuthController.resetSecondFactor(user.id);
  return method;
}

/**
 * Two-factor sign-in (M5). `router` is the caller's own setup at `/api/auth/totp`; `adminRouter` is the admin reset
 * at `/api/users/:id/totp`. The login second step (`POST /api/auth/login/totp`) stays in `AuthController`.
 * Contracts: STRUCTURE.md "M5: tenancy" (TOTP). Wrong passwords or codes count in the per-user failure limiter.
 * Audit: `user.totp_enabled`, `user.totp_disabled`, `user.recovery_codes_issued`, `user.totp_reset`; each pushes
 * `user.updated`.
 */
export namespace TotpController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/auth/totp → TotpStatusResponse.
   */
  router.get("/", async (c) => {
    const user = c.var.user;
    return c.json<TotpStatusResponse>({
      enabled: user.totpEnabled,
      pending: !user.totpEnabled && user.totpSecret !== null,
      recoveryCodesLeft: user.totpEnabled ? await RecoveryCode.countLeft(user.id) : 0,
    });
  });

  /**
   * POST /api/auth/totp/setup → TotpSetupResponse. Stores a pending secret (`totpEnabled` stays false; a pending one
   * is replaced). 409 while two-factor is on.
   */
  router.post("/setup", async (c) => {
    const user = c.var.user;
    const secret = generateSecret();
    // Conditional, so a setup racing a confirm can't swap the secret under an enabled account.
    const [affected] = await User.update({ totpSecret: secret, totpLastStep: null }, { where: { id: user.id, totpEnabled: false } });
    if (affected !== 1) throw HttpError.conflict("Two-factor sign-in is already on. Turn two-factor sign-in off first.");
    return c.json<TotpSetupResponse>({ secret, otpauthUrl: otpauthUrl(secret, user.username) });
  });

  /**
   * POST /api/auth/totp/confirm  TotpConfirmBody → TotpConfirmResponse. Turns two-factor on when the code matches the
   * pending secret and issues the recovery codes. 400 wrong code, 409 no pending setup.
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
      return await RecoveryCode.issue(user.id, transaction);
    });
    // Not dirty: the row already holds these values.
    user.setDataValue("totpEnabled", true);
    user.setDataValue("totpLastStep", step);
    await AuditLog.record({ action: "user.totp_enabled", actorId: user.id, ip: clientIp(c) });
    pushUserUpdated(user.id);
    return c.json<TotpConfirmResponse>({ user: user.toClientJSON(), recoveryCodes });
  });

  /**
   * POST /api/auth/totp/disable  TotpDisableBody → UserDto. Needs the password and a current or recovery code (401).
   * 409 while two-factor is off. Ends no sessions.
   */
  router.post("/disable", async (c) => {
    const body = await readBody<TotpDisableBody>(c);
    const user = c.var.user;
    if (!user.totpEnabled) throw HttpError.conflict("Two-factor sign-in is already off.");
    const method = await assertSecondProof(c, user, body);
    await user.clearTotp();
    await AuditLog.record({ action: "user.totp_disabled", actorId: user.id, ip: clientIp(c), details: { method } });
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON());
  });

  /**
   * POST /api/auth/totp/recovery-codes  RecoveryCodesBody → RecoveryCodesResponse. Replaces every code; same proof
   * as disabling. 409 while two-factor is off.
   */
  router.post("/recovery-codes", async (c) => {
    const body = await readBody<RecoveryCodesBody>(c);
    const user = c.var.user;
    if (!user.totpEnabled) throw HttpError.conflict("Turn two-factor sign-in on first.");
    const method = await assertSecondProof(c, user, body);
    const recoveryCodes = await RecoveryCode.issue(user.id);
    await AuditLog.record({ action: "user.recovery_codes_issued", actorId: user.id, ip: clientIp(c), details: { method } });
    pushUserUpdated(user.id);
    return c.json<RecoveryCodesResponse>({ recoveryCodes });
  });

  export const adminRouter = new Hono<AppEnv>();

  adminRouter.use("*", User.$middleware({ permissions: ["USERS_MANAGE"] }));

  /**
   * POST /api/users/:id/totp/reset → UserDto. USERS_MANAGE; 403 for an admin target unless the caller is an admin.
   * Clears two-factor and the recovery codes and bumps `tokenVersion` (the user's sessions end).
   */
  adminRouter.post("/reset", async (c) => {
    const id = paramInt(c, "id");
    const actor = c.var.user;
    const target = await User.findWithRoles({ id });
    if (!target) throw HttpError.notFound("That user doesn't exist.");
    if (target.isAdmin() && !actor.isAdmin()) throw HttpError.forbidden("Only administrators can reset an administrator's two-factor sign-in.");
    await User.sequelize!.transaction(async (transaction) => {
      await target.clearTotp(transaction);
      await target.bumpTokenVersion(transaction);
    });
    await AuditLog.record({ action: "user.totp_reset", actorId: actor.id, ip: clientIp(c), details: { userId: id, username: target.username } });
    LiveGateway.closeUser(id, LIVE_CLOSE.UNAUTHORIZED, "Your two-factor sign-in was reset by an administrator. Sign in again.");
    pushUserUpdated(id);
    return c.json<UserDto>(target.toClientJSON());
  });
}

export default TotpController;
