import { Hono } from "hono";
import type { EffectiveQuotaDto } from "@shared/api/users.ts";
import type { AppEnv } from "../lib/http.ts";
import { Quota, User } from "../models/index.ts";

/**
 * `/api/quota` (M5): the caller's own quota and usage (the account page). Other users' quotas are
 * `/api/users/:id/quota` (USERS_MANAGE).
 */
export namespace QuotaController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/quota → EffectiveQuotaDto. Signed in.
   */
  router.get("/", async (c) => {
    return c.json<EffectiveQuotaDto>(await Quota.getEffective(c.var.user.id));
  });
}

export default QuotaController;
