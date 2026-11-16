import { type Context, Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type {
  AuthStatusResponse,
  ChallengeBody,
  ChangePasswordBody,
  EmailCodeSentResponse,
  EmailConfirmationRequired,
  ForgotPasswordBody,
  InvitePreviewResponse,
  LoginBody,
  LoginResponse,
  LoginSuccess,
  PasswordLinkPreviewResponse,
  RegisterBody,
  ResetPasswordBody,
  SecondFactorMethod,
  SecondFactorProof,
  SetupBody,
  TotpLoginBody,
  TwoFactorChallenge,
} from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { ROLES } from "@shared/permissions.ts";
import { LIMITS, LIVE_CLOSE } from "@shared/constants.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import { Mailer } from "../mail/Mailer.ts";
import { MailTemplates } from "../mail/templates.ts";
import { AuditLog, EmailToken, Invite, User } from "../models/index.ts";

/**
 * Stamp the login time and wrap the user and a fresh session token.
 */
async function startSession(user: User): Promise<LoginSuccess> {
  user.lastLoginAt = new Date();
  await user.save();
  return { step: "done", twoFactorRequired: false, token: await user.createToken(), user: user.toClientJSON() };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pushUserUpdated(userId: number): void {
  LiveGateway.push("user.updated", { userId }, { permission: "USERS_MANAGE", userIds: [userId] });
}

// Every sign-in attempt per IP, failed attempts per username, and the other public endpoints per IP.
const loginPerIp = new RateLimiter(Config.RATE_LIMIT_LOGIN_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "sign-in attempts from your address");
const loginFailuresPerUser = new RateLimiter(Config.RATE_LIMIT_LOGIN_FAILURES_PER_USER, Config.RATE_LIMIT_WINDOW_SEC, "failed sign-ins for this account");
const publicPerIp = new RateLimiter(Config.RATE_LIMIT_PUBLIC_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "requests from your address");

// M7: when each `<userId>:<kind>` may get its next email (Unix ms). In memory, like the rate limiters.
const emailCooldowns = new Map<string, number>();
const EMAIL_COOLDOWN_MAX_KEYS = 10_000;

const NO_MAIL = "The panel doesn't send email.";
const UNUSABLE_LINK = "This link has expired or was already used.";
const FORGOT_REPLACE_AFTER_MS = 15 * 60_000; // A forgot request replaces a live reset link only once it's this old.
const CHALLENGE_EXPIRED = "Your sign-in timed out or is no longer valid. Enter your password again.";

/**
 * The rate-limit key for the caller: the client IP (`X-Forwarded-For` only with TRUST_PROXY).
 */
function ipKey(c: Context): string {
  return clientIp(c) ?? "unknown";
}

/**
 * Where a 6-digit code came from, from a request body; anything but `email` is `totp`.
 */
function parseMethod(value: unknown): SecondFactorMethod {
  return value === "email" ? "email" : "totp";
}

/**
 * After the password (or a password link): the confirmed-address gate, then the second factor, then the session.
 * Used by login, register and the password reset (STRUCTURE.md M7, "Login order").
 * @param audit Details of the `user.login` entry written when this signs in directly; false = don't write one.
 * @param viaLink The password came from a password link: the challenge says so, and with TOTP on only TOTP (or a
 * recovery code) passes it.
 */
async function beginSession(c: Context, user: User, audit: Record<string, unknown> | null | false = null, viaLink = false): Promise<LoginResponse> {
  if (!user.isAdmin() && !user.isEmailConfirmed() && AuthController.isConfirmationRequired()) {
    const address = user.pendingEmail ?? user.email;
    if (address === null) throw HttpError.forbidden("Your account needs a confirmed email address. Ask an administrator to add one.");
    AuthController.mailLater(user.id, "confirm", address, () => AuthController.confirmLinkMessage(user, address));
    return {
      step: "confirm_email",
      twoFactorRequired: false,
      challengeToken: await user.createToken("confirm"),
      emailHint: User.maskedEmail(address),
    } satisfies EmailConfirmationRequired;
  }

  const methods = user.challengeMethods(viaLink);
  if (methods.length > 0) {
    const emailOnly = methods.length === 1 && methods[0] === "email";
    return {
      step: "two_factor",
      twoFactorRequired: true,
      challengeToken: await user.createToken("totp", viaLink),
      methods,
      emailHint: methods.includes("email") && user.email ? User.maskedEmail(user.email) : null,
      emailSent: emailOnly ? await sendLoginCode(c, user) : false,
    } satisfies TwoFactorChallenge;
  }

  if (audit !== false) await AuditLog.record({ action: "user.login", actorId: user.id, ip: clientIp(c), details: audit });
  return await startSession(user);
}

/**
 * Email a sign-in code when email is the user's only second factor. Never throws: a failed send is logged and
 * answers false, and the client offers a recovery code and "Send again". Within the cooldown no new code is sent
 * while the last one still works; once it's used or out of tries a new one goes out (each needs the password, so
 * this can't be used to flood the inbox).
 * @returns Whether a code is on its way.
 */
async function sendLoginCode(c: Context, user: User): Promise<boolean> {
  const address = user.email;
  if (!Mailer.isEnabled() || address === null) return false;
  if (!AuthController.tryEmailCooldown(user.id, "login")) {
    if (await EmailToken.hasLiveCode(user.id, "login")) return true;
    AuthController.releaseEmailCooldown(user.id, "login");
    AuthController.takeEmailCooldown(user.id, "login");
  }
  try {
    await Mailer.send(address, await loginCodeMessage(c, user, address));
    return true;
  } catch (error) {
    AuthController.releaseEmailCooldown(user.id, "login");
    console.error(`sign-in code email to user ${user.id} failed`, error);
    return false;
  }
}

async function loginCodeMessage(c: Context, user: User, address: string): Promise<MailTemplates.Message> {
  const code = await EmailToken.issueCode(user.id, "login", address);
  return MailTemplates.loginCode({ username: user.username, code, ttlMinutes: LIMITS.EMAIL_CODE_TTL_MINUTES, ip: clientIp(c) });
}

/**
 * Find the account for a forgot-password request (username, else address) and email it a password link. Runs after
 * the response went out, so neither the answer nor its timing tells whether an account matched. Can't be used to
 * cancel other links: skips while a `reset` link under `FORGOT_REPLACE_AFTER_MS` old or any live `welcome` link
 * exists, and sends a `welcome` link to an account without a password.
 */
async function sendForgotLink(login: string): Promise<void> {
  let user = LIMITS.USERNAME_PATTERN.test(login) ? await User.findOne({ where: { username: login } }) : null;
  if (!user && login.includes("@") && login.length <= 255) user = await User.findOne({ where: { email: login.toLowerCase() } });
  if (!user || user.disabled || user.email === null) return;
  const live = await EmailToken.findLiveLink(user.id, ["reset", "welcome"]);
  if (live?.purpose === "welcome") return;
  if (live?.purpose === "reset" && Date.now() - live.createdAt.getTime() < FORGOT_REPLACE_AFTER_MS) return;
  const address = user.email;
  const kind = user.hasPassword ? "reset" : "welcome";
  AuthController.mailLater(user.id, "password", address, () => AuthController.passwordLinkMessage(user!, kind, address));
}

/**
 * `/api/auth`: first-run setup, login (+ second step, M7 confirmed-address gate), invite registration, the current
 * user, password change, password links (M7). Every success that signs someone in answers `LoginSuccess` (token +
 * user, `step: "done"`). Audit: `user.setup`, `user.login`, `user.login_failed`, `user.registered`,
 * `user.password_changed`, `user.password_reset`.
 * Rate limits (429 `{ message }` + `Retry-After`, RATE_LIMIT_* in .env): login per IP and failed logins per username;
 * setup, register, invite preview and password links per IP. Refused attempts are not audited.
 * Also home of the helpers the other account controllers share: the second-factor limiter and proof, and the email
 * cooldown and senders (M7).
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
   * M7: with an address and mail on, a confirmation link goes out in the background.
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
    const address = user.email;
    if (address !== null) mailLater(user.id, "confirm", address, () => confirmLinkMessage(user, address));
    return c.json<LoginSuccess>(await startSession(user), 201);
  });

  /**
   * POST /api/auth/login  LoginBody → LoginResponse. Public. 401 "Wrong username or password." for any failure.
   * Then `beginSession`: `confirm_email` (M7 gate; 403 without any address), `two_factor` (a `totp`-purpose JWT,
   * 5 minutes; with email the only method a code is sent now, `emailSent` says whether that worked), or `done`.
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
    return c.json<LoginResponse>(await beginSession(c, user));
  });

  /**
   * POST /api/auth/login/totp  TotpLoginBody → LoginSuccess. Public, rate-limited per IP; every code attempt counts in
   * `loginFailuresPerUser` (key `totp:<userId>`, see `hitSecondFactor`). 401 "Your sign-in timed out…" for a bad or
   * expired challenge, 401 "The code is wrong or was already used." for a wrong code, a replayed time step, a used or
   * exhausted email code, or a used recovery code. `method: "email"` (M7) checks an emailed `login` code; refused
   * (401) for a challenge from a password link while TOTP is on.
   * The self-service TOTP routes are in `TotpController` (`/api/auth/totp`).
   */
  router.post("/login/totp", async (c) => {
    loginPerIp.hit(ipKey(c));
    const body = await readBody<TotpLoginBody>(c);
    const challenge = await User.findChallenge(asString(body.challengeToken), "totp");
    if (!challenge) throw HttpError.unauthorized(CHALLENGE_EXPIRED);
    const { user } = challenge;
    hitSecondFactor(user.id);
    const requested = parseMethod(body.method);
    if (!user.challengeMethods(challenge.viaLink).includes(requested)) {
      throw HttpError.unauthorized("After a password link, use your authenticator app or a recovery code.");
    }
    const method = await user.consumeSecondFactor(asString(body.code), requested, "login");
    if (!method) {
      await AuditLog.record({ action: "user.login_failed", actorId: user.id, ip: clientIp(c), details: { username: user.username, stage: "totp" } });
      throw HttpError.unauthorized("The code is wrong or was already used.");
    }
    resetSecondFactor(user.id);
    await AuditLog.record({ action: "user.login", actorId: user.id, ip: clientIp(c), details: { method } });
    return c.json<LoginSuccess>(await startSession(user));
  });

  /**
   * POST /api/auth/login/email-code  ChallengeBody → EmailCodeSentResponse (M7). Emails a new sign-in code (the old
   * one stops working). 401 bad challenge, 409 email two-factor off, mail off or a password-link challenge while TOTP
   * is on, 429 within the email cooldown,
   * 502 when the relay refuses.
   */
  router.post("/login/email-code", async (c) => {
    loginPerIp.hit(ipKey(c));
    const body = await readBody<ChallengeBody>(c);
    const challenge = await User.findChallenge(asString(body.challengeToken), "totp");
    if (!challenge) throw HttpError.unauthorized(CHALLENGE_EXPIRED);
    const { user } = challenge;
    const address = user.email;
    if (!user.emailTwoFactor || address === null) throw HttpError.conflict("Email two-factor sign-in is off for this account.");
    if (!user.challengeMethods(challenge.viaLink).includes("email")) {
      throw HttpError.conflict("After a password link, use your authenticator app or a recovery code.");
    }
    await mailNow(user.id, "login", address, () => loginCodeMessage(c, user, address));
    return c.json<EmailCodeSentResponse>({ emailHint: User.maskedEmail(address) });
  });

  /**
   * POST /api/auth/login/confirm-email/resend  ChallengeBody → OkResponse (M7). Sends the confirmation link of the
   * login gate again, to the pending address or else the unconfirmed one. 401 bad challenge, 409 nothing to confirm
   * or mail off, 429 within the email cooldown, 502 when the relay refuses.
   */
  router.post("/login/confirm-email/resend", async (c) => {
    loginPerIp.hit(ipKey(c));
    const body = await readBody<ChallengeBody>(c);
    const user = await User.findByChallenge(asString(body.challengeToken), "confirm");
    if (!user) throw HttpError.unauthorized(CHALLENGE_EXPIRED);
    const address = unconfirmedAddress(user);
    if (address === null) throw HttpError.conflict("Your email address is already confirmed. Sign in again.");
    await mailNow(user.id, "confirm", address, () => confirmLinkMessage(user, address));
    return c.json<OkResponse>({ ok: true });
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
   * POST /api/auth/register  RegisterBody → 201 LoginResponse. Public. 400 when the invite is unusable (or, M7, the
   * address is missing while the panel requires a confirmed one). With an address and mail on, a confirmation link
   * goes out; then `beginSession` (usually `confirm_email` while the gate is on).
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
    pushUserUpdated(user.id);
    const address = user.email;
    if (address !== null) mailLater(user.id, "confirm", address, () => confirmLinkMessage(user, address));
    return c.json<LoginResponse>(await beginSession(c, user, false), 201);
  });

  /**
   * GET /api/auth/me → UserDto. Signed in.
   */
  router.get("/me", User.$middleware(), (c) => {
    return c.json<UserDto>(c.var.user.toClientJSON());
  });

  /**
   * POST /api/auth/password  ChangePasswordBody → LoginSuccess. Signed in. 401 when `currentPassword` is wrong.
   * Bumps `tokenVersion` (other sessions end; LiveGateway closes their sockets) and returns a fresh token. M7: a
   * "password changed" notice goes to the address.
   */
  router.post("/password", User.$middleware(), async (c) => {
    const body = await readBody<ChangePasswordBody>(c);
    const user = c.var.user;
    if (!await user.checkPassword(asString(body.currentPassword))) throw HttpError.unauthorized("The current password is wrong.");
    User.verifyPassword(body.newPassword);
    await user.setPassword(body.newPassword);
    await User.sequelize!.transaction(async (transaction) => {
      await user.bumpTokenVersion(transaction);
      await EmailToken.revoke(user.id, ["reset", "welcome"], transaction);
    });
    await AuditLog.record({ action: "user.password_changed", actorId: user.id, ip: clientIp(c) });
    // Reconnect rather than sign out: the caller's own socket picks up the new token, old sessions fail auth.
    LiveGateway.closeUser(user.id, LIVE_CLOSE.RECONNECT, "Password changed.");
    notify(user, "passwordChanged", () => MailTemplates.passwordChanged({ username: user.username, by: "you" }));
    return c.json<LoginSuccess>(await startSession(user));
  });

  //#region Password links (M7)
  /**
   * POST /api/auth/password/forgot  ForgotPasswordBody → OkResponse. Public, per IP. 409 while mail is off.
   * Always answers the same: the account lookup and the reset link (`PASSWORD_RESET_TTL_MINUTES`) happen in the
   * background, for an enabled account with an address, at most once per email cooldown.
   */
  router.post("/password/forgot", async (c) => {
    publicPerIp.hit(ipKey(c));
    const body = await readBody<ForgotPasswordBody>(c);
    if (!Mailer.isEnabled()) throw HttpError.conflict("Password reset by email isn't set up on this panel. Ask an administrator.");
    const login = asString(body.login).trim();
    if (login !== "") {
      sendForgotLink(login).catch((error) => console.error("forgot-password lookup failed", error));
    }
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * GET /api/auth/password/reset/:token → PasswordLinkPreviewResponse. Public, per IP. Doesn't use the link.
   */
  router.get("/password/reset/:token", async (c) => {
    publicPerIp.hit(ipKey(c));
    const link = await EmailToken.findLink(c.req.param("token"), ["reset", "welcome"]);
    const user = link ? await User.findByPk(link.userId) : null;
    if (!link || !user || user.disabled) return c.json<PasswordLinkPreviewResponse>({ valid: false, kind: null, username: null, expiresAt: null });
    return c.json<PasswordLinkPreviewResponse>({
      valid: true,
      kind: link.purpose === "welcome" ? "welcome" : "reset",
      username: user.username,
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  /**
   * POST /api/auth/password/reset  ResetPasswordBody → LoginResponse. Public, per IP. Validates the password, then
   * uses the link (single use): sets the password, ends every session, revokes the user's other password links,
   * confirms the address, sends a notice (not for `welcome`), then `beginSession` with a `viaLink` challenge
   * (two-factor still applies; with TOTP on only TOTP or a recovery code). 400 for an unusable link, a link to an
   * address the account no longer has, or a disabled account.
   */
  router.post("/password/reset", async (c) => {
    publicPerIp.hit(ipKey(c));
    const body = await readBody<ResetPasswordBody>(c);
    User.verifyPassword(body.password);
    const link = await EmailToken.consumeLink(body.token, ["reset", "welcome"]);
    if (!link) throw HttpError.badRequest(UNUSABLE_LINK);
    const user = await User.findWithRoles({ id: link.userId });
    // A link sent to an address the account no longer has is dead (revoked on every address change, checked here too).
    if (!user || user.disabled || link.email !== user.email) throw HttpError.badRequest(UNUSABLE_LINK);
    const kind = link.purpose === "welcome" ? "welcome" : "reset";

    await user.setPassword(body.password);
    user.tokenVersion += 1;
    if (user.emailVerifiedAt === null) user.emailVerifiedAt = new Date();
    await User.sequelize!.transaction(async (transaction) => {
      await user.save({ transaction });
      await EmailToken.revoke(user.id, ["reset", "welcome"], transaction);
    });

    LiveGateway.closeUser(user.id, LIVE_CLOSE.UNAUTHORIZED, "Your password was reset. Sign in again.");
    if (kind === "reset") notify(user, "passwordChanged", () => MailTemplates.passwordChanged({ username: user.username, by: "link" }));
    await AuditLog.record({ action: "user.password_reset", actorId: user.id, ip: clientIp(c), details: { kind } });
    pushUserUpdated(user.id);
    return c.json<LoginResponse>(await beginSession(c, user, { via: "password_link" }, true));
  });
  //#endregion

  //#region Second factor (shared with TotpController, EmailController)
  /**
   * Count one second-factor attempt (login step two, disabling 2FA, new recovery codes) in the per-user failure
   * limiter, key `totp:<userId>` (usernames can't contain `:`). Counted before the code is checked, so parallel
   * guesses can't all slip past the limit; a success calls `resetSecondFactor`.
   * @throws HttpError 429 + Retry-After when the user is at `RATE_LIMIT_LOGIN_FAILURES_PER_USER`.
   */
  export function hitSecondFactor(userId: number): void {
    loginFailuresPerUser.hit(`totp:${userId}`);
  }

  /**
   * Forget the user's second-factor attempts after a correct code.
   */
  export function resetSecondFactor(userId: number): void {
    loginFailuresPerUser.reset(`totp:${userId}`);
  }

  /**
   * The proof disabling either second factor and new recovery codes need: the password, then a current code (TOTP,
   * or with `method: "email"` an emailed `action` code) or a recovery code (used up). Every attempt counts in the
   * per-user second-factor limiter; the password is checked first, so a wrong password never uses up a code.
   * @returns The method that matched.
   * @throws HttpError 401 when either is wrong, 429 at the limit.
   */
  export async function assertSecondProof(c: Context<AppEnv>, user: User, body: Partial<SecondFactorProof>): Promise<User.SecondFactorMatch> {
    hitSecondFactor(user.id);
    const passwordOk = await user.checkPassword(asString(body.password));
    const method = passwordOk ? await user.consumeSecondFactor(asString(body.code), parseMethod(body.method), "action") : null;
    if (!passwordOk || !method) {
      await AuditLog.record({ action: "user.login_failed", actorId: user.id, ip: clientIp(c), details: { username: user.username, stage: "totp" } });
      throw HttpError.unauthorized(passwordOk ? "The code is wrong or was already used." : "The password is wrong.");
    }
    resetSecondFactor(user.id);
    return method;
  }

  /**
   * Check the signed-in user's password for a sensitive change (email address, email two-factor) when no second
   * factor is on. Every attempt counts in the per-user failure limiter (key `password:<userId>`) before the check,
   * so parallel guesses can't slip past it; a correct password resets it.
   * @throws HttpError 401 when it's wrong, 429 at the limit.
   */
  export async function assertPassword(user: User, password: unknown): Promise<void> {
    const key = `password:${user.id}`;
    loginFailuresPerUser.hit(key);
    if (!await user.checkPassword(asString(password))) throw HttpError.unauthorized("The password is wrong.");
    loginFailuresPerUser.reset(key);
  }

  /**
   * The proof for adding, moving or removing a second factor (`SecondFactorProof`): `assertSecondProof` while one is
   * on, else only the password (`assertPassword`).
   * @returns The method that matched, or null when only the password was checked.
   */
  export async function assertFactorChangeProof(c: Context<AppEnv>, user: User, body: Partial<SecondFactorProof>): Promise<User.SecondFactorMatch | null> {
    if (user.hasSecondFactor()) return await assertSecondProof(c, user, body);
    await assertPassword(user, body.password);
    return null;
  }
  //#endregion

  //#region Email helpers (M7)
  /**
   * Whether sign-in needs a confirmed address: mail on and `requireConfirmedEmail` (admins are exempt; callers check).
   */
  export function isConfirmationRequired(): boolean {
    return Mailer.requiresConfirmedEmail();
  }

  /**
   * The address a confirmation link would go to: the pending one, else `email` while unconfirmed; null when there's
   * nothing to confirm.
   */
  export function unconfirmedAddress(user: User): string | null {
    if (user.pendingEmail !== null && user.pendingEmail !== undefined) return user.pendingEmail;
    return user.email !== null && !user.isEmailConfirmed() ? user.email : null;
  }

  /**
   * A full panel link, e.g. `panelLink("reset-password", token)` → `<PUBLIC_URL>/reset-password?token=…`.
   */
  export function panelLink(path: string, token: string): string {
    return `${Config.PUBLIC_URL}/${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Take the email cooldown of `<userId>:<kind>` (one email per `LIMITS.EMAIL_RESEND_SECONDS`).
   * @throws HttpError 429 "Wait a minute before asking for another email." + Retry-After while it runs.
   */
  export function takeEmailCooldown(userId: number, kind: string): void {
    const key = `${userId}:${kind}`;
    const until = emailCooldowns.get(key) ?? 0;
    const now = Date.now();
    if (until > now) throw HttpError.tooManyRequests("Wait a minute before asking for another email.", Math.max(1, Math.ceil((until - now) / 1000)));
    if (emailCooldowns.size >= EMAIL_COOLDOWN_MAX_KEYS) {
      for (const [k, t] of emailCooldowns) {
        if (t <= now) emailCooldowns.delete(k);
      }
    }
    emailCooldowns.set(key, now + LIMITS.EMAIL_RESEND_SECONDS * 1000);
  }

  /**
   * Give a cooldown back after the email didn't go out.
   */
  export function releaseEmailCooldown(userId: number, kind: string): void {
    emailCooldowns.delete(`${userId}:${kind}`);
  }

  /**
   * Like `takeEmailCooldown`, for sends that skip silently (forgot password, notices).
   * @returns false while the cooldown runs.
   */
  export function tryEmailCooldown(userId: number, kind: string): boolean {
    try {
      takeEmailCooldown(userId, kind);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A user-facing email: 409 while mail is off, the cooldown (429), then `build()` (which issues the token) and
   * `Mailer.send`. A failed send gives the cooldown back and throws the relay's 502.
   */
  export async function mailNow(userId: number, kind: string, to: string, build: () => Promise<MailTemplates.Message>): Promise<void> {
    if (!Mailer.isEnabled()) throw HttpError.conflict(NO_MAIL);
    takeEmailCooldown(userId, kind);
    try {
      await Mailer.send(to, await build());
    } catch (error) {
      emailCooldowns.delete(`${userId}:${kind}`);
      throw error;
    }
  }

  /**
   * An email that never blocks or fails the request: nothing while mail is off or the cooldown runs, else `build()`
   * and `Mailer.send` in a background task. A failure (building or at the relay) is logged and gives the cooldown
   * back.
   */
  export function mailLater(userId: number, kind: string, to: string, build: () => MailTemplates.Message | Promise<MailTemplates.Message>): void {
    if (!Mailer.isEnabled() || !tryEmailCooldown(userId, kind)) return;
    (async () => await Mailer.send(to, await build()))().catch((error) => {
      emailCooldowns.delete(`${userId}:${kind}`);
      console.error(`${kind} email to user ${userId} failed: ${(error as Error).message}`);
    });
  }

  /**
   * A security notice to the user's address (password changed, address change requested, two-factor off), in the
   * background; skipped without an address, while mail is off or within the notice's cooldown.
   * @param to The address. Default is the user's `email`.
   */
  export function notify(user: User, kind: string, build: () => MailTemplates.Message, to?: string | null): void {
    const address = to === undefined ? user.email : to;
    if (address === null) return;
    mailLater(user.id, `notice:${kind}`, address, build);
  }

  /**
   * Issue a `confirm` link to `address` (`EMAIL_CONFIRM_TTL_HOURS`) and render its email.
   */
  export async function confirmLinkMessage(user: User, address: string): Promise<MailTemplates.Message> {
    const ttlHours = LIMITS.EMAIL_CONFIRM_TTL_HOURS;
    const token = await EmailToken.issueLink(user.id, "confirm", address, ttlHours * 3_600_000);
    return MailTemplates.confirm({ username: user.username, email: address, url: panelLink("confirm-email", token), ttlHours });
  }

  /**
   * Issue a password link to `address` and render its email: `reset` (`PASSWORD_RESET_TTL_MINUTES`) or `welcome`
   * (`PASSWORD_SETUP_TTL_HOURS`, "set your password").
   * @param createdBy For `welcome`: who created the account.
   */
  export async function passwordLinkMessage(user: User, kind: "reset" | "welcome", address: string, createdBy?: string): Promise<MailTemplates.Message> {
    if (kind === "reset") {
      const ttlMinutes = LIMITS.PASSWORD_RESET_TTL_MINUTES;
      const token = await EmailToken.issueLink(user.id, "reset", address, ttlMinutes * 60_000);
      return MailTemplates.reset({ username: user.username, url: panelLink("reset-password", token), ttlMinutes });
    }
    const ttlHours = LIMITS.PASSWORD_SETUP_TTL_HOURS;
    const token = await EmailToken.issueLink(user.id, "welcome", address, ttlHours * 3_600_000);
    return MailTemplates.welcome({
      username: user.username,
      createdBy: createdBy ?? "an administrator",
      url: panelLink("reset-password", token),
      ttlHours,
      hasPassword: user.hasPassword,
    });
  }
  //#endregion
}

export default AuthController;
