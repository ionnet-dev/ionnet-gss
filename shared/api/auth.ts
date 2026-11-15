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
 * `POST /api/auth/totp/setup`: a new secret to scan; not active until confirmed.
 */
export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
}

export interface TotpConfirmBody {
  code: string;
}

export interface TotpDisableBody {
  password: string;
  code: string;
}
//#endregion
