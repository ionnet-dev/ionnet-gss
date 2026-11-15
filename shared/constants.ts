/**
 * Values both sides need: product name, token prefixes, input limits and the live socket's close codes.
 */

export const APP_NAME = "Ionnet GSS";

/**
 * Prefixes of the secrets the panel hands out. Only a SHA-256 of each full token is stored.
 */
export const TOKEN_PREFIX = {
  ENROL: "gss_enrol_",
  HOST: "gss_host_",
  INVITE: "gss_inv_",
} as const;

export const LIMITS = {
  USERNAME_PATTERN: /^[a-zA-Z0-9_.-]{3,32}$/,
  PASSWORD_MIN: 10, // Characters.
  PASSWORD_MAX_BYTES: 72, // UTF-8 bytes: bcrypt ignores the rest. Check with `passwordBytes()`.
  HOST_NAME_MAX: 64,
  SERVER_NAME_MAX: 64,
  TOTP_DIGITS: 6,
} as const;

/**
 * Length of a password in UTF-8 bytes, the unit of `LIMITS.PASSWORD_MAX_BYTES`.
 */
export function passwordBytes(password: string): number {
  let bytes = 0;
  for (const char of password) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Why a new password can't be used (a short sentence for a form field), or null when it can.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < LIMITS.PASSWORD_MIN) return `Use at least ${LIMITS.PASSWORD_MIN} characters.`;
  if (passwordBytes(password) > LIMITS.PASSWORD_MAX_BYTES) {
    return `Use at most ${LIMITS.PASSWORD_MAX_BYTES} bytes (${LIMITS.PASSWORD_MAX_BYTES} plain letters or digits; accented letters and emoji count 2-4 each).`;
  }
  return null;
}

/**
 * Close codes of `/ws/live` (the browser socket).
 */
export const LIVE_CLOSE = {
  /**
   * No valid `auth` frame in time, or the token expired. The client signs out.
   */
  UNAUTHORIZED: 4401,
  /**
   * The user's access changed (role, disabled, password). Reconnect to pick it up.
   */
  RECONNECT: 4002,
} as const;
