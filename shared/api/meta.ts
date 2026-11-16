/**
 * `GET /api/health` and `GET /api/meta`.
 */

export interface HealthResponse {
  ok: boolean;
  database: "up" | "down";
}

export interface MetaResponse {
  name: string;
  version: string;
  /**
   * Public panel URL (`PUBLIC_URL`), for enrol commands and invite links.
   */
  publicUrl: string;
  /**
   * Agent protocol version this panel speaks.
   */
  protocolVersion: number;
  /**
   * M7: the panel sends email (`MailSettingsDto.enabled`): "Forgot password?", welcome links and email two-factor are
   * available.
   */
  mailEnabled: boolean;
  /**
   * M7: non-admins need a confirmed address to sign in (only true while `mailEnabled`); registration asks for one.
   */
  requireConfirmedEmail: boolean;
}
