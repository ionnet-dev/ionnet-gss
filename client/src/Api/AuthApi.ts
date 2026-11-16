import type {
  AuthStatusResponse,
  ChangePasswordBody,
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

  export function register(body: RegisterBody): Promise<LoginSuccess> {
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

  export function setupTotp(): Promise<TotpSetupResponse> {
    return BaseApi.POST("/auth/totp/setup");
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
}

export default AuthApi;
