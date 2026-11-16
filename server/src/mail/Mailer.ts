import nodemailer from "nodemailer";
import type { UpdateMailSettingsBody } from "@shared/api/settings.ts";
import { APP_NAME } from "@shared/constants.ts";
import { HttpError } from "../lib/HttpError.ts";
import * as secretBox from "../lib/secretBox.ts";
import { Setting } from "../models/index.ts";
import { MailTemplates } from "./templates.ts";

type Transport = ReturnType<typeof nodemailer.createTransport>;

const CONNECTION_TIMEOUT_MS = 10_000; // TCP connect.
const GREETING_TIMEOUT_MS = 10_000; // The server's 220 greeting after connecting.
const SOCKET_TIMEOUT_MS = 20_000; // Silence on an open connection.
const DNS_TIMEOUT_MS = 10_000;

/**
 * Sends the panel's email through the relay in the `mail` setting (M7). The only importer of `nodemailer`. The
 * transport is built lazily from the settings and rebuilt by `reload()` after they change.
 */
export class Mailer {
  private constructor() { }

  private static _transport: Promise<Mailer.Relay> | null = null;

  /**
   * Whether mail is turned on (sync: reads the settings cache, which `Setting` loads at startup).
   */
  public static isEnabled(): boolean {
    return Setting.get("mail").enabled;
  }

  /**
   * Whether non-admins need a confirmed address to sign in: mail is on and `requireConfirmedEmail` is set.
   */
  public static requiresConfirmedEmail(): boolean {
    const mail = Setting.get("mail");
    return mail.enabled && mail.requireConfirmedEmail;
  }

  /**
   * Send one message and wait for the relay's answer.
   * @throws HttpError 409 while mail is off, 502 with the relay's answer when sending fails.
   */
  public static async send(to: string, message: MailTemplates.Message): Promise<void> {
    if (!Mailer.isEnabled()) throw HttpError.conflict("The panel doesn't send email. An administrator can set it up under Settings.");
    const pending = Mailer._transport ??= Mailer._build(Setting.get("mail"), undefined);
    pending.catch(() => {
      if (Mailer._transport === pending) Mailer._transport = null; // Try again on the next send.
    });
    await Mailer._deliver(await pending, to, message);
  }

  /**
   * Send without waiting: failures are logged, never thrown. Does nothing while mail is off.
   */
  public static sendInBackground(to: string, message: MailTemplates.Message): void {
    if (!Mailer.isEnabled()) return;
    Mailer.send(to, message).catch((error) => {
      console.error(`email "${message.subject}" to ${to} failed: ${(error as Error).message}`);
    });
  }

  /**
   * Send the test message with `draft` merged over the stored settings (its `enabled` is ignored). Uses a transport
   * of its own, so the stored one stays as it is.
   * @param sentBy Who asked, named in the message. Default is "An administrator".
   * @throws HttpError 400 for invalid draft values, 502 with the relay's answer.
   */
  public static async test(to: string, draft?: UpdateMailSettingsBody, sentBy?: string): Promise<void> {
    const { mail, password } = Setting.mergeMail(Setting.get("mail"), draft ?? {}, "test");
    const relay = await Mailer._build(mail, password);
    try {
      await Mailer._deliver(relay, to, MailTemplates.test({ sentBy: sentBy ?? "An administrator" }));
    } finally {
      relay.transport.close();
    }
  }

  /**
   * Drop the cached transport; the next send builds one from the current settings.
   */
  public static reload(): void {
    const old = Mailer._transport;
    Mailer._transport = null;
    old?.then((relay) => relay.transport.close()).catch(() => { });
  }

  /**
   * A transport for `mail`. `password`: undefined = open `mail.passwordBox`, null = none, a string = use it.
   * @throws HttpError 502 when the stored password can't be decrypted.
   */
  private static async _build(mail: Setting.StoredMail, password: string | null | undefined): Promise<Mailer.Relay> {
    if (password === undefined && mail.passwordBox !== null) {
      password = await secretBox.open(mail.passwordBox);
      if (password === null) {
        throw new HttpError(502, "The stored SMTP password can't be decrypted (JWT_SECRET changed since it was saved). Enter it again under Settings.");
      }
    }
    const security = {
      tls: { secure: true },
      starttls: { secure: false, requireTLS: true },
      none: { secure: false, ignoreTLS: true },
    }[mail.security];
    const transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      ...security,
      // No password (none stored, or withheld from a changed server): no AUTH at all, an anonymous attempt.
      auth: mail.username !== null && password ? { user: mail.username, pass: password } : undefined,
      tls: mail.verifyCertificate ? undefined : { rejectUnauthorized: false },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      dnsTimeout: DNS_TIMEOUT_MS,
    });
    return { transport, mail };
  }

  /**
   * @throws HttpError 502 with a readable account of what went wrong.
   */
  private static async _deliver(relay: Mailer.Relay, to: string, message: MailTemplates.Message): Promise<void> {
    try {
      await relay.transport.sendMail({
        from: { name: relay.mail.fromName ?? APP_NAME, address: relay.mail.fromAddress },
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      throw new HttpError(502, Mailer.describeError(error, relay.mail));
    }
  }

  /**
   * Turn a nodemailer error into a sentence for the admin: the relay's own answer when there is one, otherwise what
   * failed and what to check.
   */
  public static describeError(error: unknown, mail: Pick<Setting.StoredMail, "host" | "port" | "security">): string {
    const e = (error ?? {}) as Mailer.SmtpError;
    const message = sentence(typeof e.message === "string" ? e.message : String(error));
    const answer = typeof e.response === "string" && e.response !== "" ? sentence(e.response.split("\n")[0].trim()) : null;
    const where = `${mail.host}:${mail.port}`;

    // Example: ETLS "Error upgrading connection with STARTTLS: 502 5.5.1 Command not implemented"
    if (e.code === "ETLS" && e.command === "STARTTLS") {
      return `${where} doesn't offer STARTTLS${answer ? ` (${answer.replace(/\.$/, "")})` : ""}. Use TLS for port 465, or "none" only for a relay on a trusted network.`;
    }
    if (/certificate|self[- ]signed|CERT_|unable to verify/i.test(message)) {
      return `The TLS certificate of ${mail.host} isn't trusted: ${message} Fix the certificate, or turn off "Verify certificate" for a relay with a self-signed one.`;
    }
    if (e.code === "EAUTH" || e.code === "ENOAUTH") {
      return `The mail server refused the sign-in: ${answer ?? message} Check the username and password.`;
    }
    if (answer) {
      if (e.code === "EENVELOPE") return `The mail server refused the address: ${answer}`;
      return `The mail server refused the message: ${answer}`;
    }
    if (e.code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(message)) {
      return `Couldn't find the mail server ${mail.host} (the name doesn't resolve). Check the host.`;
    }
    if (/ECONNREFUSED/.test(message)) {
      return `Couldn't connect to ${where} (connection refused). Check the host and port.`;
    }
    if (/EHOSTUNREACH|ENETUNREACH/.test(message)) {
      return `Couldn't connect to ${where} (no route to the host). Check the host and the network.`;
    }
    if (e.code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) {
      return `Couldn't reach ${where} in time (${message.replace(/\.$/, "")}). Check the host, port and firewall.`;
    }
    if (/wrong version number|packet length too long|InvalidContentType|ssl3_get_record/i.test(message)) {
      const hint = mail.security === "tls"
        ? "The port probably expects STARTTLS (usually 587) or no encryption: change the security setting."
        : "Check the security setting: port 465 usually uses TLS, 587 STARTTLS.";
      return `Couldn't start TLS with ${where}. ${hint}`;
    }
    if (/ECONNRESET|ECONNECTION|closed/i.test(message) || e.code === "ECONNECTION") {
      return `${where} closed the connection (${message.replace(/\.$/, "")}). Check the port and security setting.`;
    }
    return `Sending the email failed: ${message}`;
  }
}

/**
 * `text` with a final period, so it reads as a sentence inside a message.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export namespace Mailer {
  /**
   * A transport and the settings it was built from (for `From:` and error messages).
   */
  export interface Relay {
    transport: Transport;
    mail: Setting.StoredMail;
  }

  /**
   * The fields nodemailer sets on its errors.
   */
  export interface SmtpError {
    message?: unknown;
    code?: string; // "EAUTH", "ETLS", "EDNS", "ESOCKET", …
    response?: unknown; // The server's answer, e.g. "535 5.7.8 Authentication failed".
    responseCode?: number;
    command?: string; // "CONN", "STARTTLS", "AUTH PLAIN", …
  }
}

export default Mailer;
