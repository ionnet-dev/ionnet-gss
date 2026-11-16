import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { MailSettingsDto, TestMailBody, UpdateMailSettingsBody } from "@shared/api/settings.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { type AppEnv, clientIp, readBody } from "../lib/http.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import * as secretBox from "../lib/secretBox.ts";
import { Mailer } from "../mail/Mailer.ts";
import { AuditLog, Setting, User } from "../models/index.ts";

const TESTS_PER_USER = 10; // Test emails per admin and rate-limit window.

const testsPerUser = new RateLimiter(TESTS_PER_USER, Config.RATE_LIMIT_WINDOW_SEC, "test emails");

/**
 * `/api/settings` (M7, administrators only): the mail relay. Audit `settings.mail_changed` (never the password),
 * `settings.mail_tested`; live `settings.updated`.
 */
export namespace SettingsController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ admin: true }));

  /**
   * The stored mail settings as the client sees them: the password only as `hasPassword` / `passwordUnreadable`.
   */
  async function mailDto(): Promise<MailSettingsDto> {
    const { passwordBox, ...mail } = Setting.get("mail");
    const updatedAt = Setting.updatedAt("mail");
    return {
      ...mail,
      hasPassword: passwordBox !== null,
      passwordUnreadable: passwordBox !== null && await secretBox.open(passwordBox) === null,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  /**
   * GET /api/settings/mail → MailSettingsDto.
   */
  router.get("/mail", async (c) => {
    return c.json<MailSettingsDto>(await mailDto());
  });

  /**
   * PUT /api/settings/mail  UpdateMailSettingsBody → MailSettingsDto. 400 names the wrong field. Absent fields stay.
   */
  router.put("/mail", async (c) => {
    const body = await readBody<UpdateMailSettingsBody>(c);
    const { mail, password, changes } = Setting.mergeMail(Setting.get("mail"), body, "save");
    if (password !== undefined) mail.passwordBox = password === null ? null : await secretBox.seal(password);
    if (changes.length > 0) {
      await Setting.set("mail", mail);
      Mailer.reload();
      await AuditLog.record({ action: "settings.mail_changed", actorId: c.var.user.id, ip: clientIp(c), details: { changes } });
      LiveGateway.push("settings.updated", { key: "mail" }, { all: true });
    }
    return c.json<MailSettingsDto>(await mailDto());
  });

  /**
   * POST /api/settings/mail/test  TestMailBody → OkResponse. `settings` are tried without being saved. 502 with the
   * relay's answer. Rate-limited per admin.
   */
  router.post("/mail/test", async (c) => {
    const user = c.var.user;
    const body = await readBody<TestMailBody>(c);
    const to = User.normalizeEmail(body.to);
    if (to === null) throw HttpError.badRequest("Enter the address to send the test email to.");
    if (body.settings !== undefined && (body.settings === null || typeof body.settings !== "object" || Array.isArray(body.settings))) {
      throw HttpError.badRequest("settings must be an object of mail settings.");
    }
    testsPerUser.hit(String(user.id));

    const audit = (ok: boolean) => AuditLog.record({ action: "settings.mail_tested", actorId: user.id, ip: clientIp(c), details: { to, ok } });
    try {
      await Mailer.test(to, body.settings, user.username);
    } catch (error) {
      const invalidDraft = error instanceof HttpError && error.status === 400; // Nothing was sent.
      if (!invalidDraft) await audit(false);
      throw error;
    }
    await audit(true);
    return c.json<OkResponse>({ ok: true });
  });
}

export default SettingsController;
