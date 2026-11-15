import { Hono } from "hono";
import { type AppEnv, paramUuid } from "../lib/http.ts";
import { User } from "../models/index.ts";
import { MetricsService } from "../servers/MetricsService.ts";

/**
 * `/api/servers/:id/metrics` (M4), mounted by `ApiController`.
 */
export namespace MetricsController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/metrics → ServerMetricsResponse.
   */
  router.get("/", async (c) => {
    return c.json(await MetricsService.get(c.var.user, paramUuid(c, "id")));
  });
}

export default MetricsController;
