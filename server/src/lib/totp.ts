/**
 * TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with WebCrypto, no dependency. M5.
 */
import { HttpError } from "./HttpError.ts";

/**
 * Seconds per time step.
 */
export const TOTP_PERIOD_SEC = 30;

/**
 * A new base32 secret (20 random bytes, RFC 4648 alphabet, no padding).
 */
export function generateSecret(): string {
  throw HttpError.notImplemented("totp.generateSecret"); // TODO(builder): M5
}

/**
 * `otpauth://totp/Ionnet%20GSS:<username>?secret=…&issuer=Ionnet%20GSS&algorithm=SHA1&digits=6&period=30` for the
 * QR code. Label and issuer are URI-encoded.
 */
export function otpauthUrl(secret: string, username: string): string {
  throw HttpError.notImplemented("totp.otpauthUrl"); // TODO(builder): M5
}

/**
 * The time step `unixSeconds` falls in (default: now).
 */
export function currentStep(unixSeconds?: number): number {
  return Math.floor((unixSeconds ?? Date.now() / 1000) / TOTP_PERIOD_SEC);
}

/**
 * The code for one time step (HOTP of the step counter, dynamic truncation, `LIMITS.TOTP_DIGITS` digits).
 */
export async function codeAt(secret: string, step: number): Promise<string> {
  throw HttpError.notImplemented("totp.codeAt"); // TODO(builder): M5
}

/**
 * Check `code` against the steps now-1, now and now+1 (clock drift), skipping any step not newer than `afterStep`
 * (replay guard). Compares in constant time.
 * @param afterStep The user's `totpLastStep`, or null.
 * @returns The matched step, or null.
 */
export async function verifyCode(secret: string, code: string, afterStep: number | null): Promise<number | null> {
  throw HttpError.notImplemented("totp.verifyCode"); // TODO(builder): M5
}
