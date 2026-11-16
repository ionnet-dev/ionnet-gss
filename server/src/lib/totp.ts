/**
 * TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with WebCrypto, no dependency. M5.
 */
import { LIMITS } from "@shared/constants.ts";

/**
 * Seconds per time step.
 */
export const TOTP_PERIOD_SEC = 30;

const ISSUER = "Ionnet GSS";
const SECRET_BYTES = 20;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32 without padding.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Decode RFC 4648 base32. Case, spaces and `=` padding are ignored.
 * @throws Error when the text has a character outside the alphabet.
 */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`"${char}" is not a base32 character.`);
    buffer = ((buffer << 5) | value) & 0xffff; // Only the low bits that are still to be emitted matter.
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * A new base32 secret (20 random bytes, RFC 4648 alphabet, no padding).
 */
export function generateSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * `otpauth://totp/Ionnet%20GSS:<username>?secret=…&issuer=Ionnet%20GSS&algorithm=SHA1&digits=6&period=30` for the
 * QR code. Label and issuer are URI-encoded.
 */
export function otpauthUrl(secret: string, username: string): string {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(username)}`;
  const query = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(ISSUER)}`,
    "algorithm=SHA1",
    `digits=${LIMITS.TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SEC}`,
  ].join("&");
  return `otpauth://totp/${label}?${query}`;
}

/**
 * The time step `unixSeconds` falls in (default: now).
 */
export function currentStep(unixSeconds?: number): number {
  return Math.floor((unixSeconds ?? Date.now() / 1000) / TOTP_PERIOD_SEC);
}

// Imported keys per secret are cheap to make; caching them isn't worth holding secrets in memory longer.
async function importKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
}

async function hotp(key: CryptoKey, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  // 64-bit big-endian counter; steps fit in 53 bits.
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return (binary % 10 ** LIMITS.TOTP_DIGITS).toString().padStart(LIMITS.TOTP_DIGITS, "0");
}

/**
 * The code for one time step (HOTP of the step counter, dynamic truncation, `LIMITS.TOTP_DIGITS` digits).
 */
export async function codeAt(secret: string, step: number): Promise<string> {
  return await hotp(await importKey(secret), step);
}

/**
 * Constant-time comparison of two strings of the same length (length itself is not secret here).
 */
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check `code` against the steps now-1, now and now+1 (clock drift), skipping any step not newer than `afterStep`
 * (replay guard). Compares in constant time.
 * @param afterStep The user's `totpLastStep`, or null.
 * @returns The matched step, or null.
 */
export async function verifyCode(secret: string, code: string, afterStep: number | null): Promise<number | null> {
  if (!new RegExp(`^\\d{${LIMITS.TOTP_DIGITS}}$`).test(code)) return null;
  const key = await importKey(secret);
  const now = currentStep();
  let matched: number | null = null;
  // Every candidate is computed and compared, so the time taken doesn't tell which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const equal = safeEquals(await hotp(key, step), code);
    if (equal && matched === null && (afterStep === null || step > afterStep)) matched = step;
  }
  return matched;
}
