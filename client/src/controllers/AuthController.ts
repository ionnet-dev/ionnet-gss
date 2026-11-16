/**
 * Who is signed in, and what they may do. Created once (`authController`); components read it with `useAuth()`.
 * Owns the session lifecycle: first-run check, login (+ TOTP step), register, sign-out, and the live socket.
 */
import type { ChangePasswordBody, LoginBody, LoginResponse, RecoveryCodesBody, RegisterBody, SetupBody, TotpDisableBody } from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import type { Permission } from "@shared/permissions.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import { BaseApi } from "@/Api/BaseApi.ts";
import { liveSocket } from "@/live/LiveSocket.ts";
import { Controller } from "./Controller.ts";

export class AuthController extends Controller {
  public user: UserDto | null = BaseApi.getUser();
  /**
   * null until `init()` has asked the panel.
   */
  public setupRequired: boolean | null = null;
  public ready = false;

  private _initStarted = false;
  /**
   * Set while a request may answer 401 for a reason other than an expired session (a wrong current password).
   */
  private _expectUnauthorized = false;

  /**
   * Run once at startup: `GET /auth/status`, then `GET /auth/me` when a token is stored (a 401 signs out), then open
   * the live socket. Listens for `BaseApi.UNAUTHORIZED_EVENT`.
   */
  public async init(): Promise<void> {
    if (this._initStarted) return;
    this._initStarted = true;
    window.addEventListener(BaseApi.UNAUTHORIZED_EVENT, () => {
      if (!this._expectUnauthorized) this.signOut();
    });
    liveSocket.on("user.updated", (data) => {
      if (data.userId === null || data.userId === this.user?.id) this.refresh().catch(() => {});
    });
    liveSocket.onReconnect(() => this.refresh().catch(() => {}));

    try {
      this.setupRequired = (await AuthApi.getStatus()).setupRequired;
    } catch {
      // Panel unreachable: show the sign-in page, whose own request will report the error.
      this.setupRequired = false;
    }

    const token = BaseApi.getToken();
    if (token && !this.setupRequired) {
      try {
        const user = await AuthApi.me();
        BaseApi.setUser(user);
        this.user = user;
        liveSocket.connect(token);
      } catch {
        // A 401 already signed out through the unauthorized event. Any other failure keeps the stored session, so a
        // panel restart doesn't log everyone out.
        if (BaseApi.getToken()) liveSocket.connect(token);
      }
    }
    else if (token) {
      BaseApi.clearSession();
      this.user = null;
    }

    this.ready = true;
    this.notify();
  }

  public isSignedIn(): boolean {
    return this.user !== null;
  }

  /**
   * Whether the user holds `permission` (admins hold every key; the panel already expands it in `permissions`).
   */
  public has(permission: Permission): boolean {
    return this.user?.permissions.includes(permission) ?? false;
  }

  /**
   * Password step. On `LoginSuccess` the session is stored; on a TOTP challenge the caller shows the code field and
   * calls `completeTotp()`.
   */
  public async login(body: LoginBody): Promise<LoginResponse> {
    const response = await AuthApi.login(body);
    if (!response.twoFactorRequired) this.applySession(response.token, response.user);
    return response;
  }

  public async completeTotp(challengeToken: string, code: string): Promise<void> {
    const response = await AuthApi.loginTotp({ challengeToken, code });
    this.applySession(response.token, response.user);
  }

  public async setup(body: SetupBody): Promise<void> {
    const response = await AuthApi.setup(body);
    this.setupRequired = false;
    this.applySession(response.token, response.user);
  }

  public async register(body: RegisterBody): Promise<void> {
    const response = await AuthApi.register(body);
    this.applySession(response.token, response.user);
  }

  /**
   * Change the password. The panel ends every other session and answers with a fresh one for this tab.
   */
  public async changePassword(body: ChangePasswordBody): Promise<void> {
    const response = await this._allowUnauthorized(() => AuthApi.changePassword(body));
    this.applySession(response.token, response.user);
  }

  //#region Two-factor (M5)
  /**
   * Turn two-factor on with a code for the pending secret (`AuthApi.setupTotp`).
   * @returns The recovery codes, which the panel sends only this once.
   */
  public async confirmTotp(code: string): Promise<string[]> {
    const response = await AuthApi.confirmTotp({ code });
    this._setUser(response.user);
    return response.recoveryCodes;
  }

  /**
   * Turn two-factor off. A wrong password or code answers 401, which here doesn't sign out.
   */
  public async disableTotp(body: TotpDisableBody): Promise<void> {
    this._setUser(await this._allowUnauthorized(() => AuthApi.disableTotp(body)));
  }

  /**
   * Replace every recovery code. Same proof as `disableTotp()`.
   * @returns The new codes, shown once.
   */
  public async regenerateRecoveryCodes(body: RecoveryCodesBody): Promise<string[]> {
    return (await this._allowUnauthorized(() => AuthApi.regenerateRecoveryCodes(body))).recoveryCodes;
  }
  //#endregion

  /**
   * Store a fresh session the panel handed out outside the sign-in flow, e.g. `UpdateUserResponse.token` after the
   * user changed their own roles (the old token stopped working).
   */
  public adoptSession(token: string, user: UserDto): void {
    this.applySession(token, user);
  }

  /**
   * Refetch the current user (after a role change or `user.updated` for self).
   */
  public async refresh(): Promise<void> {
    if (!this.user) return;
    const user = await AuthApi.me();
    BaseApi.setUser(user);
    this.user = user;
    this.notify();
  }

  /**
   * Drop the token, close the live socket, go to /login.
   */
  public signOut(): void {
    BaseApi.clearSession();
    liveSocket.disconnect();
    this.user = null;
    this.notify();
  }

  /**
   * Run a request whose 401 means a wrong password or code, not an ended session.
   */
  private async _allowUnauthorized<T>(request: () => Promise<T>): Promise<T> {
    this._expectUnauthorized = true;
    try {
      return await request();
    } finally {
      this._expectUnauthorized = false;
    }
  }

  private _setUser(user: UserDto): void {
    BaseApi.setUser(user);
    this.user = user;
    this.notify();
  }

  /**
   * Store a fresh session from any `LoginSuccess`.
   */
  protected applySession(token: string, user: UserDto): void {
    BaseApi.setSession(token, user);
    this.user = user;
    liveSocket.connect(token);
    this.notify();
  }
}

/**
 * The app's one auth controller.
 */
export const authController = new AuthController();

export default authController;
