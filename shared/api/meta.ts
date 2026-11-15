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
}
