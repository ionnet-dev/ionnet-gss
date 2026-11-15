import { Hono } from "hono";
import type { HealthResponse, MetaResponse } from "@shared/api/meta.ts";
import { PROTOCOL_VERSION } from "@shared/protocol/protocol.gen.ts";
import { AppSystem } from "../AppSystem.ts";
import { Config } from "../Config.ts";
import type { AppEnv } from "../lib/http.ts";
import { isDatabaseUp } from "../models/index.ts";

/**
 * `GET /api/health` and `GET /api/meta`. Public.
 */
export namespace MetaController {
  export const router = new Hono<AppEnv>();

  /**
   * GET /api/health → HealthResponse (503 when the database is down).
   */
  router.get("/health", async (c) => {
    const up = await isDatabaseUp();
    return c.json<HealthResponse>({ ok: up, database: up ? "up" : "down" }, up ? 200 : 503);
  });

  /**
   * GET /api/meta → MetaResponse.
   */
  router.get("/meta", (c) => {
    return c.json<MetaResponse>({
      name: AppSystem.name,
      version: AppSystem.version,
      publicUrl: Config.PUBLIC_URL,
      protocolVersion: PROTOCOL_VERSION,
    });
  });
}

export default MetaController;
