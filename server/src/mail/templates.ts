/**
 * The panel's emails (M7), pure: each function returns the subject, a plain-text body and an HTML body. Every value
 * that comes from a user is escaped in the HTML.
 */
import { APP_NAME } from "@shared/constants.ts";
import { Config } from "../Config.ts";

//#region Layout
/**
 * Escape text for HTML element content and double-quoted attributes.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A piece of the HTML body: already-safe markup. Build one with `html` (escapes every interpolated value) or `raw`.
 */
interface Html {
  readonly markup: string;
}

function raw(markup: string): Html {
  return { markup };
}

/**
 * Tagged template that escapes every interpolated value, except `Html` pieces.
 */
function html(strings: TemplateStringsArray, ...values: (string | number | Html)[]): Html {
  let markup = strings[0];
  values.forEach((value, i) => {
    markup += typeof value === "object" ? value.markup : escapeHtml(String(value));
    markup += strings[i + 1];
  });
  return { markup };
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function paragraph(content: Html): Html {
  return html`<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.55; color: #1f2328;">${content}</p>`;
}

function muted(content: Html): Html {
  return html`<p style="margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: #59636e;">${content}</p>`;
}

function button(label: string, url: string): Html {
  return html`<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 8px 0 24px;"><tr><td style="border-radius: 6px; background: #2563eb;"><a href="${url}" style="display: inline-block; padding: 11px 22px; font-family: ${FONT}; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">${label}</a></td></tr></table>`;
}

/**
 * The link under the button, for mail clients that hide buttons, as selectable text.
 */
function linkFallback(url: string): Html {
  return muted(html`If the button doesn't work, copy this link into your browser:<br><a href="${url}" style="color: #2563eb; word-break: break-all;">${url}</a>`);
}

function code(value: string): Html {
  return html`<p style="margin: 8px 0 24px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 30px; font-weight: 700; letter-spacing: 6px; color: #1f2328;">${value}</p>`;
}

/**
 * The whole message: a heading, the body pieces and a footer naming the panel.
 */
function layout(heading: string, body: Html[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #f3f4f6;"><tr><td align="center" style="padding: 32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px;">
<tr><td style="padding: 20px 32px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 14px; font-weight: 700; color: #1f2328;">${escapeHtml(APP_NAME)}</td></tr>
<tr><td style="padding: 28px 32px 12px; font-family: ${FONT};">
<h1 style="margin: 0 0 20px; font-size: 20px; line-height: 1.3; color: #1f2328;">${escapeHtml(heading)}</h1>
${body.map((piece) => piece.markup).join("\n")}
</td></tr>
<tr><td style="padding: 16px 32px 24px; border-top: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 12px; line-height: 1.5; color: #59636e;">Sent by the ${escapeHtml(APP_NAME)} panel at <a href="${escapeHtml(Config.PUBLIC_URL)}" style="color: #59636e;">${escapeHtml(Config.PUBLIC_URL)}</a>.</td></tr>
</table>
</td></tr></table>
</body>
</html>
`;
}

/**
 * The plain-text body: paragraphs separated by blank lines, then the same footer as the HTML.
 */
function textBody(paragraphs: string[]): string {
  return `${paragraphs.join("\n\n")}\n\n--\nSent by the ${APP_NAME} panel at ${Config.PUBLIC_URL}.\n`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

const NOT_YOU = "If you didn't ask for this, you can ignore this email.";
const CONTACT_ADMIN = "If this wasn't you, sign in and change your password, or contact an administrator.";
//#endregion

export namespace MailTemplates {
  export interface Message {
    subject: string;
    text: string;
    html: string;
  }

  /**
   * Confirm an address. `url` is the full confirmation link.
   */
  export function confirm(data: { username: string; email: string; url: string; ttlHours: number }): Message {
    const heading = "Confirm your email address";
    const expiry = `The link works for ${plural(data.ttlHours, "hour")}.`;
    return {
      subject: `${heading} for ${APP_NAME}`,
      text: textBody([
        `Hi ${data.username},`,
        `Confirm that ${data.email} is the address for your ${APP_NAME} account by opening this link:`,
        data.url,
        `${expiry} ${NOT_YOU}`,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`Confirm that <strong>${data.email}</strong> is the address for your ${APP_NAME} account.`),
        button("Confirm email address", data.url),
        linkFallback(data.url),
        muted(html`${expiry} ${NOT_YOU}`),
      ]),
    };
  }

  /**
   * Forgot password or an admin-sent reset.
   */
  export function reset(data: { username: string; url: string; ttlMinutes: number }): Message {
    const heading = "Reset your password";
    const expiry = `The link works for ${plural(data.ttlMinutes, "minute")} and only once.`;
    const ignore = "If you didn't ask for a new password, you can ignore this email: your password stays as it is.";
    return {
      subject: `Reset your ${APP_NAME} password`,
      text: textBody([
        `Hi ${data.username},`,
        `Someone asked to reset the password of your ${APP_NAME} account. Choose a new one here:`,
        data.url,
        `${expiry} ${ignore}`,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`Someone asked to reset the password of your ${APP_NAME} account. Choose a new one with the button below.`),
        button("Choose a new password", data.url),
        linkFallback(data.url),
        muted(html`${expiry} ${ignore}`),
      ]),
    };
  }

  /**
   * Account created by an admin. `hasPassword`: the admin also set a password ("use it, or choose your own here").
   */
  export function welcome(data: { username: string; createdBy: string; url: string; ttlHours: number; hasPassword: boolean }): Message {
    const heading = `Welcome to ${APP_NAME}`;
    const intro = `${data.createdBy} created an account for you. Your username is ${data.username}.`;
    const action = data.hasPassword
      ? "You can sign in with the password you were given, or choose your own with this link:"
      : "Choose a password to start using it:";
    const expiry = `The link works for ${plural(data.ttlHours, "hour")} and only once.${data.hasPassword ? "" : " After that, ask an administrator for a new one."}`;
    return {
      subject: `Your ${APP_NAME} account`,
      text: textBody([
        `Hi ${data.username},`,
        intro,
        action,
        data.url,
        expiry,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`${data.createdBy} created an account for you. Your username is <strong>${data.username}</strong>.`),
        paragraph(html`${action.replace(/:$/, ".")}`),
        button(data.hasPassword ? "Choose your own password" : "Set your password", data.url),
        linkFallback(data.url),
        muted(html`${expiry}`),
      ]),
    };
  }

  /**
   * Sign-in code.
   */
  export function loginCode(data: { username: string; code: string; ttlMinutes: number; ip: string | null }): Message {
    const heading = "Your sign-in code";
    const from = data.ip ? ` from ${data.ip}` : "";
    const expiry = `The code works for ${plural(data.ttlMinutes, "minute")}.`;
    const warning = "If you aren't signing in right now, someone else has your password: change it as soon as you can.";
    return {
      subject: `${data.code} is your ${APP_NAME} sign-in code`,
      text: textBody([
        `Hi ${data.username},`,
        `Enter this code to finish signing in${from}:`,
        data.code,
        `${expiry} ${warning}`,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`Enter this code to finish signing in${from}:`),
        code(data.code),
        muted(html`${expiry} ${warning}`),
      ]),
    };
  }

  /**
   * Code confirming a sensitive action. `action` is a lowercase phrase: "turn off two-factor sign-in".
   */
  export function actionCode(data: { username: string; code: string; ttlMinutes: number; action: string }): Message {
    const heading = "Your confirmation code";
    const expiry = `The code works for ${plural(data.ttlMinutes, "minute")}.`;
    return {
      subject: `${data.code} is your ${APP_NAME} confirmation code`,
      text: textBody([
        `Hi ${data.username},`,
        `Enter this code to ${data.action}:`,
        data.code,
        `${expiry} ${CONTACT_ADMIN}`,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`Enter this code to ${data.action}:`),
        code(data.code),
        muted(html`${expiry} ${CONTACT_ADMIN}`),
      ]),
    };
  }

  /**
   * Notice: the password was changed. `by`: "you", "a password link" or "an administrator".
   */
  export function passwordChanged(data: { username: string; by: "you" | "link" | "admin" }): Message {
    const heading = "Your password was changed";
    const how = {
      you: "The password of your account was just changed from the account page.",
      link: "The password of your account was just changed with a password link sent to this address.",
      admin: "An administrator just set a new password for your account.",
    }[data.by];
    const after = "Other sessions were signed out.";
    return {
      subject: `Your ${APP_NAME} password was changed`,
      text: textBody([
        `Hi ${data.username},`,
        `${how} ${after}`,
        CONTACT_ADMIN,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`${how} ${after}`),
        muted(html`${CONTACT_ADMIN}`),
      ]),
    };
  }

  /**
   * Notice to the old address: a change to `newEmail` was requested.
   */
  export function emailChangeRequested(data: { username: string; newEmail: string }): Message {
    const heading = "Your email address is being changed";
    const after = "The change takes effect once the new address is confirmed. Until then this address stays on the account.";
    return {
      subject: `Your ${APP_NAME} email address is being changed`,
      text: textBody([
        `Hi ${data.username},`,
        `Someone asked to change the email address of your account to ${data.newEmail}.`,
        after,
        CONTACT_ADMIN,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`Someone asked to change the email address of your account to <strong>${data.newEmail}</strong>.`),
        paragraph(html`${after}`),
        muted(html`${CONTACT_ADMIN}`),
      ]),
    };
  }

  /**
   * Notice: a second factor was turned on from the account page.
   */
  export function twoFactorOn(data: { username: string; method: "totp" | "email" }): Message {
    const heading = "Two-factor sign-in was turned on";
    const what = data.method === "totp" ? "Sign-in with an authenticator app" : "Sign-in codes by email";
    return {
      subject: `Two-factor sign-in was turned on for your ${APP_NAME} account`,
      text: textBody([
        `Hi ${data.username},`,
        `${what} was just turned on for your account from the account page.`,
        CONTACT_ADMIN,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`${what} was just turned on for your account from the account page.`),
        muted(html`${CONTACT_ADMIN}`),
      ]),
    };
  }

  /**
   * Notice: a second factor was turned off. `admin`: by an administrator's reset.
   */
  export function twoFactorOff(data: { username: string; method: "totp" | "email" | "all"; admin: boolean }): Message {
    const heading = "Two-factor sign-in was turned off";
    const what = {
      totp: "Sign-in with an authenticator app",
      email: "Sign-in codes by email",
      all: "Two-factor sign-in",
    }[data.method];
    const who = data.admin ? "by an administrator" : "from the account page";
    const after = data.admin
      ? "You can turn it on again from your account page."
      : CONTACT_ADMIN;
    return {
      subject: `Two-factor sign-in was turned off for your ${APP_NAME} account`,
      text: textBody([
        `Hi ${data.username},`,
        `${what} was just turned off for your account ${who}.`,
        after,
      ]),
      html: layout(heading, [
        paragraph(html`Hi ${data.username},`),
        paragraph(html`${what} was just turned off for your account ${who}.`),
        muted(html`${after}`),
      ]),
    };
  }

  /**
   * The settings page's test message.
   */
  export function test(data: { sentBy: string }): Message {
    const heading = "Test email";
    const body = `${data.sentBy} sent this from the ${APP_NAME} settings page to check the mail relay. It works: the panel can send email.`;
    return {
      subject: `${APP_NAME} test email`,
      text: textBody([body]),
      html: layout(heading, [paragraph(html`${body}`)]),
    };
  }
}

export default MailTemplates;
