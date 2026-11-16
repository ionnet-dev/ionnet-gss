import type { OkResponse } from "@shared/api/common.ts";
import type {
  AuthStatusResponse,
  ChallengeBody,
  ChangeEmailBody,
  ChangePasswordBody,
  ConfirmEmailBody,
  ConfirmEmailResponse,
  EmailCodeSentResponse,
  EmailTwoFactorDisableBody,
  EmailTwoFactorEnableBody,
  EmailTwoFactorEnableResponse,
  ForgotPasswordBody,
  PasswordLinkPreviewResponse,
  ResetPasswordBody,
  InvitePreviewResponse,
  LoginBody,
  LoginResponse,
  LoginSuccess,
  RegisterBody,
  RecoveryCodesBody,
  RecoveryCodesResponse,
  SetupBody,
  TotpConfirmBody,
  TotpConfirmResponse,
  TotpDisableBody,
  TotpLoginBody,
  TotpSetupBody,
  TotpSetupResponse,
  TotpStatusResponse,
} from "@shared/api/auth.ts";
import type { MetaResponse } from "@shared/api/meta.ts";
import type { UserDto } from "@shared/api/users.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/auth` and `/api/meta`. Session storage is `AuthController`'s job; these only call the routes.
 */
export namespace AuthApi {
  export function getMeta(): Promise<MetaResponse> {
    return BaseApi.GET("/meta");
  }

  export function getStatus(): Promise<AuthStatusResponse> {
    return BaseApi.GET("/auth/status");
  }

  export function setup(body: SetupBody): Promise<LoginSuccess> {
    return BaseApi.POST("/auth/setup", body);
  }

  export function login(body: LoginBody): Promise<LoginResponse> {
    return BaseApi.POST("/auth/login", body);
  }

  export function loginTotp(body: TotpLoginBody): Promise<LoginSuccess> {
    return BaseApi.POST("/auth/login/totp", body);
  }

  export function previewInvite(code: string): Promise<InvitePreviewResponse> {
    return BaseApi.GET(`/auth/invite/${encodeURIComponent(code)}`);
  }

  /**
   * M7: `confirm_email` when the panel requires a confirmed address.
   */
  export function register(body: RegisterBody): Promise<LoginResponse> {
    return BaseApi.POST("/auth/register", body);
  }

  export function me(): Promise<UserDto> {
    return BaseApi.GET("/auth/me");
  }

  export function changePassword(body: ChangePasswordBody): Promise<LoginSuccess> {
    return BaseApi.POST("/auth/password", body);
  }

  //#region TOTP (M5)
  export function getTotp(): Promise<TotpStatusResponse> {
    return BaseApi.GET("/auth/totp");
  }

  /**
   * M7: `body` (password + code) only while email two-factor is on.
   */
  export function setupTotp(body?: TotpSetupBody): Promise<TotpSetupResponse> {
    return BaseApi.POST("/auth/totp/setup", body ?? {});
  }

  export function confirmTotp(body: TotpConfirmBody): Promise<TotpConfirmResponse> {
    return BaseApi.POST("/auth/totp/confirm", body);
  }

  export function disableTotp(body: TotpDisableBody): Promise<UserDto> {
    return BaseApi.POST("/auth/totp/disable", body);
  }

  export function regenerateRecoveryCodes(body: RecoveryCodesBody): Promise<RecoveryCodesResponse> {
    return BaseApi.POST("/auth/totp/recovery-codes", body);
  }
  //#endregion

  //#region Email (M7)
  /**
   * Second step: email a new sign-in code. 429 within `LIMITS.EMAIL_RESEND_SECONDS`.
   */
  export function sendLoginEmailCode(body: ChallengeBody): Promise<EmailCodeSentResponse> {
    return BaseApi.POST("/auth/login/email-code", body);
  }

  /**
   * The `confirm_email` login step: send the confirmation link again.
   */
  export function resendLoginConfirmation(body: ChallengeBody): Promise<OkResponse> {
    return BaseApi.POST("/auth/login/confirm-email/resend", body);
  }

  export function forgotPassword(body: ForgotPasswordBody): Promise<OkResponse> {
    return BaseApi.POST("/auth/password/forgot", body);
  }

  export function previewPasswordLink(token: string): Promise<PasswordLinkPreviewResponse> {
    return BaseApi.GET(`/auth/password/reset/${encodeURIComponent(token)}`);
  }

  /**
   * Answers like `login`: a session, or the two-factor step.
   */
  export function resetPassword(body: ResetPasswordBody): Promise<LoginResponse> {
    return BaseApi.POST("/auth/password/reset", body);
  }

  export function changeEmail(body: ChangeEmailBody): Promise<UserDto> {
    return BaseApi.POST("/auth/email", body);
  }

  /**
   * Send the confirmation link again (to the pending address, else the unconfirmed one).
   */
  export function resendEmailConfirmation(): Promise<OkResponse> {
    return BaseApi.POST("/auth/email/resend");
  }

  /**
   * Drop a pending address change.
   */
  export function cancelEmailChange(): Promise<UserDto> {
    return BaseApi.POST("/auth/email/cancel");
  }

  /**
   * Public: use a confirmation link.
   */
  export function confirmEmail(body: ConfirmEmailBody): Promise<ConfirmEmailResponse> {
    return BaseApi.POST("/auth/email/confirm", body);
  }

  export function enableEmailTwoFactor(body: EmailTwoFactorEnableBody): Promise<EmailTwoFactorEnableResponse> {
    return BaseApi.POST("/auth/email-2fa/enable", body);
  }

  export function disableEmailTwoFactor(body: EmailTwoFactorDisableBody): Promise<UserDto> {
    return BaseApi.POST("/auth/email-2fa/disable", body);
  }

  /**
   * Email a code that proves a sensitive action (disable a method, new recovery codes).
   */
  export function sendActionEmailCode(): Promise<EmailCodeSentResponse> {
    return BaseApi.POST("/auth/email-2fa/code");
  }
  //#endregion
}

export default AuthApi;
