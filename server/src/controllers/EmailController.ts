import { Hono } from "hono";
import { Op, UniqueConstraintError } from "sequelize";
import type { OkResponse } from "@shared/api/common.ts";
import type {
  ChangeEmailBody,
  ConfirmEmailBody,
  ConfirmEmailResponse,
  EmailCodeSentResponse,
  EmailTwoFactorDisableBody,
  EmailTwoFactorEnableBody,
  EmailTwoFactorEnableResponse,
} from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { LIMITS } from "@shared/constants.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import { Mailer } from "../mail/Mailer.ts";
import { MailTemplates } from "../mail/templates.ts";
import { AuditLog, EmailToken, RecoveryCode, User } from "../models/index.ts";
import { AuthController } from "./AuthController.ts";

const NO_MAIL = "The panel doesn't send email.";
const UNUSABLE_LINK = "This link has expired or was already used.";
const EMAIL_TAKEN = "That email address is already used by another account.";
// Tokens tied to the account's address: revoked whenever the address changes (M7 review fixes).
const ADDRESS_BOUND: EmailToken.Purpose[] = ["confirm", "reset", "welcome", "login", "action"];

// The public confirmation route, per IP (its own counter: AuthController's limiters are private to it).
const confirmPerIp = new RateLimiter(Config.RATE_LIMIT_PUBLIC_PER_IP, Config.RATE_LIMIT_WINDOW_SEC, "requests from your address");

function pushUserUpdated(userId: number): void {
  LiveGateway.push("user.updated", { userId }, { permission: "USERS_MANAGE", userIds: [userId] });
}

/**
 * Whether another account already uses `address` as its (current) address.
 */
async function isEmailTaken(address: string, userId: number): Promise<boolean> {
  const other = await User.findOne({ where: { email: address }, attributes: ["id"] });
  return other !== null && other.id !== userId;
}

/**
 * `/api/auth/email` and `/api/auth/email-2fa` (M7): your own address (change, confirm, resend, cancel) and email
 * two-factor (enable, disable, action code). Login steps and password links stay in `AuthController`.
 * Contracts: STRUCTURE.md "M7: email" (Address, Email two-factor). Each change pushes `user.updated`.
 * Audit: `user.email_change_requested`, `user.email_confirmed`, `user.email_removed`, `user.email_2fa_enabled`,
 * `user.email_2fa_disabled`.
 */
export namespace EmailController {
  export const router = new Hono<AppEnv>(); // /api/auth/email
  export const twoFactorRouter = new Hono<AppEnv>(); // /api/auth/email-2fa

  //#region Address
  /**
   * POST /api/auth/email/confirm  ConfirmEmailBody → ConfirmEmailResponse. Public (the link may be opened signed out),
   * per IP. Uses the link once; for the pending address it swaps it in (409 when another account took it meanwhile:
   * the pending address stays), for the current one it marks it confirmed. 400 unusable link, or a link for an
   * address that's no longer on the account.
   */
  router.post("/confirm", async (c) => {
    confirmPerIp.hit(clientIp(c) ?? "unknown");
    const body = await readBody<ConfirmEmailBody>(c);
    const link = await EmailToken.consumeLink(body.token, ["confirm"]);
    if (!link) throw HttpError.badRequest(UNUSABLE_LINK);
    const user = await User.findWithRoles({ id: link.userId });
    if (!user || user.disabled) throw HttpError.badRequest(UNUSABLE_LINK);

    if (link.email === user.pendingEmail) {
      if (await isEmailTaken(link.email, user.id)) throw HttpError.conflict(`${EMAIL_TAKEN} Choose another one.`);
      user.email = link.email;
      user.pendingEmail = null;
      user.emailVerifiedAt = new Date();
      await User.sequelize!.transaction(async (transaction) => {
        try {
          await user.save({ transaction });
        } catch (error) {
          if (error instanceof UniqueConstraintError) throw HttpError.conflict(`${EMAIL_TAKEN} Choose another one.`);
          throw error;
        }
        // Links and codes sent to the old address stop working.
        await EmailToken.revoke(user.id, ["reset", "welcome", "login", "action"], transaction);
      });
    }
    else if (link.email === user.email) {
      if (user.emailVerifiedAt === null) {
        user.emailVerifiedAt = new Date();
        await user.save();
      }
    }
    else {
      throw HttpError.badRequest("This link is for an address that's no longer on the account.");
    }

    await AuditLog.record({ action: "user.email_confirmed", actorId: user.id, ip: clientIp(c), details: { email: link.email } });
    pushUserUpdated(user.id);
    return c.json<ConfirmEmailResponse>({ email: link.email, username: user.username });
  });

  router.use("*", User.$middleware());

  /**
   * POST /api/auth/email  ChangeEmailBody → UserDto. The same address changes nothing. Then the proof: the password,
   * plus a code of the second factor already on (`SecondFactorProof`; email codes are `action` codes) while one is
   * (401). Mail on: the new address becomes `pendingEmail`, gets a confirmation link and the old address a notice
   * (429 within the email cooldown, 502 when the relay refuses; the pending address is kept then). Mail off: it
   * replaces `email` at once, unconfirmed. `null` removes the address. An address change or removal revokes the
   * user's password links and emailed codes. 409: address taken; removing while email two-factor is on or while the
   * panel requires a confirmed address (non-admins); changing with mail off while email two-factor is on.
   */
  router.post("/", async (c) => {
    const body = await readBody<ChangeEmailBody>(c);
    const user = c.var.user;
    if (body.email === undefined) throw HttpError.badRequest("Give the new email address, or null to remove it.");
    const address = User.normalizeEmail(body.email);

    if (address === null) {
      if (user.email === null && user.pendingEmail === null) return c.json<UserDto>(user.toClientJSON());
      if (user.emailTwoFactor) throw HttpError.conflict("Turn email two-factor sign-in off before removing your address.");
      if (!user.isAdmin() && AuthController.isConfirmationRequired()) {
        throw HttpError.conflict("This panel requires a confirmed email address. Change it instead of removing it.");
      }
      await AuthController.assertFactorChangeProof(c, user, body);
      const removed = user.email ?? user.pendingEmail;
      await User.sequelize!.transaction(async (transaction) => {
        user.email = null;
        user.pendingEmail = null;
        user.emailVerifiedAt = null;
        await user.save({ transaction });
        await EmailToken.revoke(user.id, ADDRESS_BOUND, transaction);
      });
      await AuditLog.record({ action: "user.email_removed", actorId: user.id, ip: clientIp(c), details: { email: removed } });
      pushUserUpdated(user.id);
      return c.json<UserDto>(user.toClientJSON());
    }

    if (address === user.email || address === user.pendingEmail) return c.json<UserDto>(user.toClientJSON());
    if (await isEmailTaken(address, user.id)) throw HttpError.conflict(EMAIL_TAKEN);
    const mailOn = Mailer.isEnabled();
    if (!mailOn && user.emailTwoFactor) throw HttpError.conflict("Turn email two-factor sign-in off before changing your address.");
    await AuthController.assertFactorChangeProof(c, user, body);

    if (mailOn) {
      const oldAddress = user.email;
      // Cooldown before saving, so a refused request changes nothing.
      AuthController.takeEmailCooldown(user.id, "confirm");
      user.pendingEmail = address;
      await user.save();
      await AuditLog.record({ action: "user.email_change_requested", actorId: user.id, ip: clientIp(c), details: { email: address, pending: true } });
      pushUserUpdated(user.id);
      if (oldAddress !== null) {
        AuthController.notify(user, "emailChangeRequested", () => MailTemplates.emailChangeRequested({ username: user.username, newEmail: address }), oldAddress);
      }
      try {
        await Mailer.send(address, await AuthController.confirmLinkMessage(user, address));
      } catch (error) {
        AuthController.releaseEmailCooldown(user.id, "confirm");
        throw error;
      }
      return c.json<UserDto>(user.toClientJSON());
    }

    await User.sequelize!.transaction(async (transaction) => {
      user.email = address;
      user.pendingEmail = null;
      user.emailVerifiedAt = null;
      try {
        await user.save({ transaction });
      } catch (error) {
        if (error instanceof UniqueConstraintError) throw HttpError.conflict(EMAIL_TAKEN);
        throw error;
      }
      await EmailToken.revoke(user.id, ADDRESS_BOUND, transaction);
    });
    await AuditLog.record({ action: "user.email_change_requested", actorId: user.id, ip: clientIp(c), details: { email: address, pending: false } });
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON());
  });

  /**
   * POST /api/auth/email/resend → OkResponse. A new confirmation link to the pending address, else the unconfirmed
   * current one. 409 nothing to confirm or mail off, 429 within the email cooldown, 502 when the relay refuses.
   */
  router.post("/resend", async (c) => {
    const user = c.var.user;
    const address = AuthController.unconfirmedAddress(user);
    if (address === null) throw HttpError.conflict(user.email === null ? "Add an email address first." : "Your email address is already confirmed.");
    await AuthController.mailNow(user.id, "confirm", address, () => AuthController.confirmLinkMessage(user, address));
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/auth/email/cancel → UserDto. Drops the pending address; its confirmation link stops working.
   */
  router.post("/cancel", async (c) => {
    const user = c.var.user;
    if (user.pendingEmail === null) return c.json<UserDto>(user.toClientJSON());
    await User.sequelize!.transaction(async (transaction) => {
      user.pendingEmail = null;
      await user.save({ transaction });
      await EmailToken.revoke(user.id, ["confirm"], transaction);
    });
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON());
  });
  //#endregion

  //#region Email two-factor
  twoFactorRouter.use("*", User.$middleware());

  /**
   * POST /api/auth/email-2fa/enable  EmailTwoFactorEnableBody → EmailTwoFactorEnableResponse. 409 already on, mail
   * off, or no confirmed address. Then the proof: the password, plus a TOTP or recovery code while TOTP is on (401).
   * When it's the first second factor (TOTP off, no unused recovery codes) new recovery codes are issued and returned
   * once; otherwise `recoveryCodes` is null. Sends a "two-factor turned on" notice.
   */
  twoFactorRouter.post("/enable", async (c) => {
    const body = await readBody<EmailTwoFactorEnableBody>(c);
    const user = c.var.user;
    if (user.emailTwoFactor) throw HttpError.conflict("Email two-factor sign-in is already on.");
    if (!Mailer.isEnabled()) throw HttpError.conflict(NO_MAIL);
    if (!user.isEmailConfirmed()) throw HttpError.conflict("Confirm your email address first.");
    await AuthController.assertFactorChangeProof(c, user, body);

    const recoveryCodes = await User.sequelize!.transaction(async (transaction) => {
      // Conditional, so the address can't change between the checks above and turning it on.
      const [affected] = await User.update({ emailTwoFactor: true }, {
        where: { id: user.id, emailTwoFactor: false, email: user.email!, emailVerifiedAt: { [Op.ne]: null } },
        transaction,
      });
      if (affected !== 1) throw HttpError.conflict("Your account changed in the meantime. Reload and try again.");
      // A TOTP setup started before this can't be confirmed without the new factor's proof.
      await User.update({ totpSecret: null, totpLastStep: null }, { where: { id: user.id, totpEnabled: false }, transaction });
      if (user.totpEnabled || await RecoveryCode.count({ where: { userId: user.id, usedAt: null }, transaction }) > 0) return null;
      return await RecoveryCode.issue(user.id, transaction);
    });
    user.setDataValue("emailTwoFactor", true);
    AuthController.notify(user, "twoFactorOn:email", () => MailTemplates.twoFactorOn({ username: user.username, method: "email" }));
    await AuditLog.record({ action: "user.email_2fa_enabled", actorId: user.id, ip: clientIp(c) });
    pushUserUpdated(user.id);
    return c.json<EmailTwoFactorEnableResponse>({ user: user.toClientJSON(), recoveryCodes });
  });

  /**
   * POST /api/auth/email-2fa/disable  EmailTwoFactorDisableBody → UserDto. Same proof as disabling TOTP (password +
   * a code from either method or a recovery code; 401, 429). 409 while it's off. Recovery codes go only when TOTP is
   * off too. Sends a "two-factor turned off" notice.
   */
  twoFactorRouter.post("/disable", async (c) => {
    const body = await readBody<EmailTwoFactorDisableBody>(c);
    const user = c.var.user;
    if (!user.emailTwoFactor) throw HttpError.conflict("Email two-factor sign-in is already off.");
    const method = await AuthController.assertSecondProof(c, user, body);
    await user.clearEmailTwoFactor();
    AuthController.notify(user, "twoFactorOff:email", () => MailTemplates.twoFactorOff({ username: user.username, method: "email", admin: false }));
    await AuditLog.record({ action: "user.email_2fa_disabled", actorId: user.id, ip: clientIp(c), details: { method } });
    pushUserUpdated(user.id);
    return c.json<UserDto>(user.toClientJSON());
  });

  /**
   * POST /api/auth/email-2fa/code → EmailCodeSentResponse. Emails an `action` code proving a sensitive action
   * (disable either method, new recovery codes). 409 email two-factor off or mail off, 429 within the email
   * cooldown, 502 when the relay refuses.
   */
  twoFactorRouter.post("/code", async (c) => {
    const user = c.var.user;
    const address = user.email;
    if (!user.emailTwoFactor || address === null) throw HttpError.conflict("Email two-factor sign-in is off.");
    await AuthController.mailNow(user.id, "action", address, async () => {
      const code = await EmailToken.issueCode(user.id, "action", address);
      return MailTemplates.actionCode({
        username: user.username,
        code,
        ttlMinutes: LIMITS.EMAIL_CODE_TTL_MINUTES,
        action: "change your two-factor sign-in settings",
      });
    });
    return c.json<EmailCodeSentResponse>({ emailHint: User.maskedEmail(address) });
  });
  //#endregion
}

export default EmailController;
