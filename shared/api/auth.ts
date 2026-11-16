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
  step: "done"; // M7: the discriminant of `LoginResponse`.
  twoFactorRequired: false;
  token: string;
  user: UserDto;
}

/**
 * A second factor the user has turned on. `totp`: authenticator app. `email`: a code sent to the confirmed address
 * (M7). Recovery codes work wherever either is asked for.
 */
export type SecondFactorMethod = "totp" | "email";

/**
 * Password accepted, a second factor still needed: send it to `POST /api/auth/login/totp` with the challenge (valid
 * 5 min).
 */
export interface TwoFactorChallenge {
  step: "two_factor";
  twoFactorRequired: true;
  challengeToken: string;
  /**
   * M7: the methods the user has on, `totp` first. With `email` only, the panel has already tried to send a code.
   */
  methods: SecondFactorMethod[];
  /**
   * M7: the address codes go to, masked (`a•••@example.com`); null without `email` in `methods`.
   */
  emailHint: string | null;
  /**
   * M7: a code was sent with this response (email was the only method). false with `email` the only method means
   * sending failed: offer a recovery code (and "Send again").
   */
  emailSent: boolean;
}

/**
 * M7: password accepted, but the panel requires a confirmed address (`MailSettingsDto.requireConfirmedEmail`) and
 * this account has none. `challengeToken` (purpose `confirm`, 30 min) lets the login page resend the link.
 */
export interface EmailConfirmationRequired {
  step: "confirm_email";
  twoFactorRequired: false;
  challengeToken: string;
  emailHint: string; // The unconfirmed address, masked.
}

export type LoginResponse = LoginSuccess | TwoFactorChallenge | EmailConfirmationRequired;

/**
 * M7: proof of the second factor already on, for actions that add, move or remove one (change your address, turn on
 * the other method, turn one off, new recovery codes). `code`: a current code (`method` says which: `totp` from the
 * app, `email` from `POST /api/auth/email-2fa/code`) or a recovery code. Without any second factor on, only the
 * password is checked and `code` is ignored. 401 when wrong.
 */
export interface SecondFactorProof {
  password: string;
  code: string;
  method?: SecondFactorMethod;
}

/**
 * `POST /api/auth/login/totp`: the second step. `code` is the 6-digit code from the app or the email, or one recovery
 * code (`xxxxx-xxxxx`; case, dashes and spaces don't matter). `method` (M7) says where a 6-digit code came from;
 * default `totp`.
 */
export interface TotpLoginBody {
  challengeToken: string;
  code: string;
  method?: SecondFactorMethod;
}

/**
 * M7: `POST /api/auth/login/email-code` (send a new sign-in code; 429 within `LIMITS.EMAIL_RESEND_SECONDS` of the last
 * one) and `POST /api/auth/login/confirm-email/resend` (send the confirmation link again).
 */
export interface ChallengeBody {
  challengeToken: string;
}

/**
 * M7: answer of `POST /api/auth/login/email-code`.
 */
export interface EmailCodeSentResponse {
  emailHint: string;
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
 * `POST /api/auth/register`: redeem an invite. Answers `LoginResponse` since M7: `confirm_email` when the panel
 * requires a confirmed address (then `email` is required too).
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
  recoveryCodesLeft: number; // Unused recovery codes; 0 when no second factor is on.
  emailEnabled: boolean; // M7: email two-factor is on.
  /**
   * M7: email two-factor can be turned on now (mail on and a confirmed address); otherwise `emailUnavailableReason`
   * says why ("Confirm your email address first.", "The panel doesn't send email.").
   */
  emailAvailable: boolean;
  emailUnavailableReason: string | null;
}

/**
 * `POST /api/auth/totp/setup`: a new secret to scan; not active until confirmed. 409 while two-factor is on.
 */
/**
 * M7: `POST /api/auth/totp/setup` body. Only needed while email two-factor is on: adding a factor needs proof of the
 * one already on (password + an `action` email code or a recovery code), else 401. Empty body otherwise.
 */
export type TotpSetupBody = Partial<SecondFactorProof>;

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
  /**
   * M7: null when another second factor (email) was already on: the existing recovery codes stay valid.
   */
  recoveryCodes: string[] | null;
}

/**
 * `code` may be a current code or a recovery code (which is then used up). M7: `method` says where a 6-digit code
 * came from (`email`: requested with `POST /api/auth/email-2fa/code`); default `totp`.
 */
export interface TotpDisableBody {
  password: string;
  code: string;
  method?: SecondFactorMethod;
}

/**
 * `POST /api/auth/totp/recovery-codes`: replaces every recovery code. Same proof as disabling.
 */
export type RecoveryCodesBody = TotpDisableBody;

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}
//#endregion

//#region Password links (M7)
/**
 * `POST /api/auth/password/forgot` (public). `login` is a username or an email address. Always answers
 * `OkResponse` (whether or not an account matched, so it can't be used to find accounts); 409 while the panel sends
 * no email.
 */
export interface ForgotPasswordBody {
  login: string;
}

/**
 * `GET /api/auth/password/reset/:token` (public): what a password link is for, without using it. `kind`: `reset`
 * (forgot password, admin-sent reset) or `welcome` (account created by an admin; "set your password").
 */
export interface PasswordLinkPreviewResponse {
  valid: boolean;
  kind: "reset" | "welcome" | null; // null when invalid.
  username: string | null;
  expiresAt: string | null;
}

/**
 * `POST /api/auth/password/reset` (public): use a password link. Sets the password, ends every other session,
 * confirms the address the link was sent to, and answers like `/auth/login` (`two_factor` when it's on).
 * 400 "This link has expired or was already used." (also when the account's address changed since it was sent).
 * M7: when the user also has the authenticator app on, the second step after a reset offers only `totp` (and
 * recovery codes): the link and an email code would both come from the same inbox.
 */
export interface ResetPasswordBody {
  token: string;
  password: string;
}
//#endregion

//#region Email address (M7)
/**
 * `POST /api/auth/email` (signed in): change your own address. With mail on, the new address becomes
 * `UserDto.pendingEmail` until confirmed (the old one keeps working and gets a notice); with mail off it replaces
 * the old one at once, unconfirmed. `email: null` removes the address (409 while email two-factor is on, or while the
 * panel requires a confirmed address and you aren't an admin). 401 wrong password. Answers `UserDto`.
 */
export interface ChangeEmailBody extends Partial<Pick<SecondFactorProof, "code" | "method">> {
  email: string | null;
  password: string;
}

/**
 * `POST /api/auth/email/confirm` (public): use a confirmation link. 400 expired/used/for an address no longer on
 * the account; 409 when a pending address was taken by another account meanwhile.
 */
export interface ConfirmEmailBody {
  token: string;
}

export interface ConfirmEmailResponse {
  email: string; // The address that is now confirmed.
  username: string;
}
//#endregion

//#region Email two-factor (M7)
/**
 * `GET /api/auth/totp` gains these fields (M7): see `TotpStatusResponse`. Enabling: `POST /api/auth/email-2fa/enable`
 * with the password; needs mail on and a confirmed address (409 otherwise).
 */
export interface EmailTwoFactorEnableBody extends Partial<Pick<SecondFactorProof, "code" | "method">> {
  password: string;
}

/**
 * `recoveryCodes`: issued (and shown once) when this is the user's first second factor; null when they already had
 * codes from the authenticator app.
 */
export interface EmailTwoFactorEnableResponse {
  user: UserDto;
  recoveryCodes: string[] | null;
}

/**
 * `POST /api/auth/email-2fa/disable`: same proof as disabling TOTP (`TotpDisableBody`: password + a code from either
 * method or a recovery code). Answers `UserDto`. Recovery codes are deleted only when no second factor is left.
 */
export type EmailTwoFactorDisableBody = TotpDisableBody;

// `POST /api/auth/email-2fa/code` (signed in, email two-factor on, no body): email a code to prove a sensitive action
// (disable either method, new recovery codes). Answers `EmailCodeSentResponse`; 429 within
// `LIMITS.EMAIL_RESEND_SECONDS`.
//#endregion
