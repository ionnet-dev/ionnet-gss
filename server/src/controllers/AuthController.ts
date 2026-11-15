import { type Context, Hono } from "hono";
import type {
  AuthStatusResponse,
  ChangePasswordBody,
  InvitePreviewResponse,
  LoginBody,
  LoginResponse,
  LoginSuccess,
  RegisterBody,
  SetupBody,
  TotpConfirmBody,
  TotpDisableBody,
  TotpLoginBody,
  TotpSetupResponse,
} from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { ROLES } from "@shared/permissions.ts";
import { LIVE_CLOSE } from "@shared/constants.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import { AuditLog, Invite, User } from "../models/index.ts";

/**
 * Stamp the login time and wrap the user and a fresh session token.
 */
async function startSession(user: User): Promise<LoginSuccess> {
  user.lastLoginAt = new Date();
  await user.save();
  return { twoFactorRequired: false, token: await user.createToken(), user: user.toClientJSON() };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Every sign-in attempt per IP, failed attempts per username, and the other public endpoints per IP.
const loginPerIp = new RateLimiter(Config.RATE_LIMIT_LOGIN_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "sign-in attempts from your address");
const loginFailuresPerUser = new RateLimiter(Config.RATE_LIMIT_LOGIN_FAILURES_PER_USER, Config.RATE_LIMIT_WINDOW_SEC, "failed sign-ins for this account");
const publicPerIp = new RateLimiter(Config.RATE_LIMIT_PUBLIC_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "requests from your address");

/**
 * The rate-limit key for the caller: the client IP (`X-Forwarded-For` only with TRUST_PROXY).
 */
function ipKey(c: Context): string {
  return clientIp(c) ?? "unknown";
}

/**
 * `/api/auth`: first-run setup, login (+ TOTP step), invite registration, the current user, password change.
 * Every success that signs someone in answers `LoginSuccess` (token + user). Audit: `user.setup`, `user.login`,
 * `user.login_failed`, `user.registered`, `user.password_changed`.
 * Rate limits (429 `{ message }` + `Retry-After`, RATE_LIMIT_* in .env): login per IP and failed logins per username;
 * setup, register and invite preview per IP. Refused attempts are not audited.
 */
export namespace AuthController {
  export const router = new Hono<AppEnv>();

  /**
   * GET /api/auth/status → AuthStatusResponse. Public.
   */
  router.get("/status", async (c) => {
    return c.json<AuthStatusResponse>({ setupRequired: !(await User.hasAnyUser()) });
  });

  /**
   * POST /api/auth/setup  SetupBody → 201 LoginSuccess. Public, only while no user exists (else 409). Creates the
   * first user with the `admin` role, under `User.lockAdminChanges()` so two concurrent setups make one admin.
   */
  router.post("/setup", async (c) => {
    publicPerIp.hit(ipKey(c));
    const body = await readBody<SetupBody>(c);
    if (await User.hasAnyUser()) throw HttpError.conflict("The panel is already set up. Sign in instead.");
    const user = await User.sequelize!.transaction(async (transaction) => {
      await User.lockAdminChanges(transaction);
      if (await User.hasAnyUser(transaction)) throw HttpError.conflict("The panel is already set up. Sign in instead.");
      return await User.registerUser({
        username: body.username as string,
        password: body.password as string,
        email: body.email,
        roleNames: [ROLES.ADMIN],
      }, transaction);
    });
    await AuditLog.record({ action: "user.setup", actorId: user.id, ip: clientIp(c), details: { username: user.username } });
    return c.json<LoginSuccess>(await startSession(user), 201);
  });

  /**
   * POST /api/auth/login  LoginBody → LoginResponse. Public. 401 "Wrong username or password." for any failure.
   * With TOTP enabled: `{ twoFactorRequired: true, challengeToken }` (a `totp`-purpose JWT, 5 minutes).
   */
  router.post("/login", async (c) => {
    loginPerIp.hit(ipKey(c));
    const body = await readBody<LoginBody>(c);
    const username = asString(body.username);
    const userKey = username.trim().toLowerCase().slice(0, 64);
    loginFailuresPerUser.check(userKey);
    const user = await User.authenticateUser(username, asString(body.password));
    if (!user) {
      loginFailuresPerUser.hit(userKey);
      await AuditLog.record({ action: "user.login_failed", ip: clientIp(c), details: { username: username.slice(0, 64) } });
      throw HttpError.unauthorized("Wrong username or password.");
    }
    loginFailuresPerUser.reset(userKey);
    if (user.totpEnabled) {
      return c.json<LoginResponse>({ twoFactorRequired: true, challengeToken: await user.createToken("totp") });
    }
    await AuditLog.record({ action: "user.login", actorId: user.id, ip: clientIp(c) });
    return c.json<LoginResponse>(await startSession(user));
  });

  /**
   * POST /api/auth/login/totp  TotpLoginBody → LoginSuccess. Public. 401 on a bad challenge or code. M5.
   */
  router.post("/login/totp", async (c) => {
    const body = await readBody<TotpLoginBody>(c);
    throw HttpError.notImplemented("POST /api/auth/login/totp"); // TODO(builder): M5
  });

  /**
   * GET /api/auth/invite/:code → InvitePreviewResponse. Public; never 404s (an unknown code is `valid: false`).
   */
  router.get("/invite/:code", async (c) => {
    publicPerIp.hit(ipKey(c));
    const invite = await Invite.findByCode(c.req.param("code"));
    if (!invite?.isUsable()) return c.json<InvitePreviewResponse>({ valid: false, email: null, expiresAt: null });
    return c.json<InvitePreviewResponse>({ valid: true, email: invite.email, expiresAt: invite.expiresAt.toISOString() });
  });

  /**
   * POST /api/auth/register  RegisterBody → 201 LoginSuccess. Public. 400 when the invite is unusable.
   */
  router.post("/register", async (c) => {
    publicPerIp.hit(ipKey(c));
    const body = await readBody<RegisterBody>(c);
    const user = await Invite.redeem(asString(body.inviteCode), {
      username: body.username as string,
      password: body.password as string,
      email: body.email,
    });
    await AuditLog.record({ action: "user.registered", actorId: user.id, ip: clientIp(c), details: { username: user.username } });
    LiveGateway.push("invite.updated", { inviteId: null }, { permission: "INVITES_MANAGE" });
    LiveGateway.push("user.updated", { userId: user.id }, { permission: "USERS_MANAGE", userIds: [user.id] });
    return c.json<LoginSuccess>(await startSession(user), 201);
  });

  /**
   * GET /api/auth/me → UserDto. Signed in.
   */
  router.get("/me", User.$middleware(), (c) => {
    return c.json<UserDto>(c.var.user.toClientJSON());
  });

  /**
   * POST /api/auth/password  ChangePasswordBody → LoginSuccess. Signed in. 401 when `currentPassword` is wrong.
   * Bumps `tokenVersion` (other sessions end; LiveGateway closes their sockets) and returns a fresh token.
   */
  router.post("/password", User.$middleware(), async (c) => {
    const body = await readBody<ChangePasswordBody>(c);
    const user = c.var.user;
    if (!await user.checkPassword(asString(body.currentPassword))) throw HttpError.unauthorized("The current password is wrong.");
    User.verifyPassword(body.newPassword);
    await user.setPassword(body.newPassword);
    await user.bumpTokenVersion();
    await AuditLog.record({ action: "user.password_changed", actorId: user.id, ip: clientIp(c) });
    // Reconnect rather than sign out: the caller's own socket picks up the new token, old sessions fail auth.
    LiveGateway.closeUser(user.id, LIVE_CLOSE.RECONNECT, "Password changed.");
    return c.json<LoginSuccess>(await startSession(user));
  });

  //#region TOTP (M5)
  /**
   * POST /api/auth/totp/setup → TotpSetupResponse. Signed in. Stores a pending secret (`totpEnabled` stays false).
   */
  router.post("/totp/setup", User.$middleware(), async (c) => {
    throw HttpError.notImplemented("POST /api/auth/totp/setup"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/confirm  TotpConfirmBody → UserDto. Signed in. Enables TOTP when the code matches.
   */
  router.post("/totp/confirm", User.$middleware(), async (c) => {
    const body = await readBody<TotpConfirmBody>(c);
    throw HttpError.notImplemented("POST /api/auth/totp/confirm"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/disable  TotpDisableBody → UserDto. Signed in. Needs the password and a current code.
   */
  router.post("/totp/disable", User.$middleware(), async (c) => {
    const body = await readBody<TotpDisableBody>(c);
    throw HttpError.notImplemented("POST /api/auth/totp/disable"); // TODO(builder): M5
  });
  //#endregion
}

export default AuthController;
