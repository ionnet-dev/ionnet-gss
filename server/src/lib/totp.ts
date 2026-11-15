/**
 * TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with WebCrypto, no dependency. M5.
 */
import { HttpError } from "./HttpError.ts";

/**
 * A new base32 secret (20 random bytes).
 */
export function generateSecret(): string {
  throw HttpError.notImplemented("totp.generateSecret"); // TODO(builder): M5.
}

/**
 * `otpauth://totp/Ionnet%20GSS:<username>?secret=…&issuer=Ionnet%20GSS` for the QR code.
 */
export function otpauthUrl(secret: string, username: string): string {
  throw HttpError.notImplemented("totp.otpauthUrl"); // TODO(builder): M5.
}

/**
 * Whether `code` is valid for `secret` now, allowing one step of clock drift either way.
 */
export async function verifyCode(secret: string, code: string): Promise<boolean> {
  throw HttpError.notImplemented("totp.verifyCode"); // TODO(builder): M5.
}
