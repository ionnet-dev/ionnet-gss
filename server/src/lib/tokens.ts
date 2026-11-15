/**
 * Secrets the panel hands out (enrol tokens, host credentials, invite codes): random, prefixed, stored as SHA-256.
 */

/**
 * A new random token: `prefix` + 32 random bytes as base64url.
 * @param prefix One of `TOKEN_PREFIX` from `@shared/constants.ts`.
 */
export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${base64}`;
}

/**
 * Lowercase hex SHA-256 of `value`; what the database stores instead of a token.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The last 6 characters, shown in lists to tell tokens apart.
 */
export function tokenHint(token: string): string {
  return token.slice(-6);
}

/**
 * Constant-time comparison of two hex digests.
 */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
