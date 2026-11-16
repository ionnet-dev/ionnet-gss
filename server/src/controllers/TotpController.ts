import { Hono } from "hono";
import type { RecoveryCodesBody, RecoveryCodesResponse, TotpConfirmBody, TotpConfirmResponse, TotpDisableBody, TotpSetupResponse, TotpStatusResponse } from "@shared/api/auth.ts";
import type { UserDto } from "@shared/api/users.ts";
import { type AppEnv, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { User } from "../models/index.ts";

/**
 * Two-factor sign-in (M5). `router` is the caller's own setup at `/api/auth/totp`; `adminRouter` is the admin reset
 * at `/api/users/:id/totp`. The login second step (`POST /api/auth/login/totp`) stays in `AuthController`.
 * Contracts: STRUCTURE.md "M5: tenancy" (TOTP). Wrong passwords or codes count in the per-user failure limiter.
 * Audit: `user.totp_enabled`, `user.totp_disabled`, `user.recovery_codes_issued`, `user.totp_reset`; each pushes
 * `user.updated`.
 */
export namespace TotpController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/auth/totp → TotpStatusResponse.
   */
  router.get("/", async (c) => {
    throw HttpError.notImplemented("GET /api/auth/totp"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/setup → TotpSetupResponse. Stores a pending secret (`totpEnabled` stays false; a pending one
   * is replaced). 409 while two-factor is on.
   */
  router.post("/setup", async (c) => {
    throw HttpError.notImplemented("POST /api/auth/totp/setup"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/confirm  TotpConfirmBody → TotpConfirmResponse. Turns two-factor on when the code matches the
   * pending secret and issues the recovery codes. 400 wrong code, 409 no pending setup.
   */
  router.post("/confirm", async (c) => {
    const body = await readBody<TotpConfirmBody>(c);
    throw HttpError.notImplemented("POST /api/auth/totp/confirm"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/disable  TotpDisableBody → UserDto. Needs the password and a current or recovery code (401).
   */
  router.post("/disable", async (c) => {
    const body = await readBody<TotpDisableBody>(c);
    throw HttpError.notImplemented("POST /api/auth/totp/disable"); // TODO(builder): M5
  });

  /**
   * POST /api/auth/totp/recovery-codes  RecoveryCodesBody → RecoveryCodesResponse. Replaces every code; same proof
   * as disabling. 409 while two-factor is off.
   */
  router.post("/recovery-codes", async (c) => {
    const body = await readBody<RecoveryCodesBody>(c);
    throw HttpError.notImplemented("POST /api/auth/totp/recovery-codes"); // TODO(builder): M5
  });

  export const adminRouter = new Hono<AppEnv>();

  adminRouter.use("*", User.$middleware({ permissions: ["USERS_MANAGE"] }));

  /**
   * POST /api/users/:id/totp/reset → UserDto. USERS_MANAGE; 403 for an admin target unless the caller is an admin.
   * Clears two-factor and the recovery codes and bumps `tokenVersion` (the user's sessions end).
   */
  adminRouter.post("/reset", async (c) => {
    const id = paramInt(c, "id");
    throw HttpError.notImplemented("POST /api/users/:id/totp/reset"); // TODO(builder): M5
  });
}

export default TotpController;
