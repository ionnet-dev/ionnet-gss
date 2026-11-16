/**
 * `/api/auth`: first-run setup, login (with the TOTP second step), invite registration, the current user.
 * Every authenticated request sends `Authorization: Bearer <token>`.
 */
import type { UserDto } from "./users.ts";

export interface AuthStatusResponse {
  /**
   * No user exists yet: the web app shows the first-run setup page.
   */
  setupRequired: boolean;
}

/**
 * `POST /api/auth/setup`: creates the first admin. 409 once any user exists.
 */
export interface SetupBody {
  username: string;
  password: string;
  email?: string | null;
}

export interface LoginBody {
  username: string;
  password: string;
}

/**
 * A signed-in session.
 */
export interface LoginSuccess {
  twoFactorRequired: false;
  token: string;
  user: UserDto;
}

/**
 * Password accepted, TOTP code still needed: send it to `POST /api/auth/login/totp` with the challenge (valid 5 min).
 */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}

export type LoginResponse = LoginSuccess | TwoFactorChallenge;

/**
 * `POST /api/auth/login/totp`. `code` is the 6-digit code from the app, or one recovery code (`xxxxx-xxxxx`; case,
 * dashes and spaces don't matter).
 */
export interface TotpLoginBody {
  challengeToken: string;
  code: string;
}

/**
 * `GET /api/auth/invite/:code` (public): whether an invite can be redeemed.
 */
export interface InvitePreviewResponse {
  valid: boolean;
  email: string | null;
  expiresAt: string | null;
}

/**
 * `POST /api/auth/register`: redeem an invite.
 */
export interface RegisterBody {
  inviteCode: string;
  username: string;
  password: string;
  email?: string | null;
}

/**
 * `POST /api/auth/password`. Bumps the token version (every other session ends) and returns a fresh session.
 */
export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

//#region TOTP (M5)
/**
 * `GET /api/auth/totp`: the caller's two-factor state.
 */
export interface TotpStatusResponse {
  enabled: boolean;
  pending: boolean; // A setup was started and not confirmed yet.
  recoveryCodesLeft: number; // Unused recovery codes; 0 when disabled.
}

/**
 * `POST /api/auth/totp/setup`: a new secret to scan; not active until confirmed. 409 while two-factor is on.
 */
export interface TotpSetupResponse {
  secret: string; // Base32, for typing it in by hand.
  otpauthUrl: string; // `otpauth://totp/…`, rendered as a QR code by the client.
}

export interface TotpConfirmBody {
  code: string;
}

/**
 * `POST /api/auth/totp/confirm`: two-factor is on. The recovery codes are in this response only.
 */
export interface TotpConfirmResponse {
  user: UserDto;
  recoveryCodes: string[];
}

/**
 * `code` may be a current code or a recovery code (which is then used up).
 */
export interface TotpDisableBody {
  password: string;
  code: string;
}

/**
 * `POST /api/auth/totp/recovery-codes`: replaces every recovery code. Same proof as disabling.
 */
export type RecoveryCodesBody = TotpDisableBody;

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}
//#endregion
