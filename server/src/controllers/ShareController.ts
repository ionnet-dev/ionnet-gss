import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateShareBody, ServerShareDto, UpdateShareBody } from "@shared/api/servers.ts";
import { type AppEnv, clientIp, paramInt, paramUuid, readBody } from "../lib/http.ts";
import { User } from "../models/index.ts";
import { ShareService } from "../servers/ShareService.ts";

/**
 * `/api/servers/:id/shares` (M5), mounted by `ApiController`. Access and rules: `ShareService`.
 */
export namespace ShareController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/shares → ServerShareDto[]. Owner level.
   */
  router.get("/", async (c) => {
    return c.json<ServerShareDto[]>(await ShareService.list(c.var.user, paramUuid(c, "id")));
  });

  /**
   * POST /api/servers/:id/shares  CreateShareBody → 201 ServerShareDto. Owner level.
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateShareBody>(c);
    return c.json<ServerShareDto>(await ShareService.add(c.var.user, paramUuid(c, "id"), body, clientIp(c)), 201);
  });

  /**
   * PATCH /api/servers/:id/shares/:userId  UpdateShareBody → ServerShareDto. Owner level.
   */
  router.patch("/:userId", async (c) => {
    const body = await readBody<UpdateShareBody>(c);
    return c.json<ServerShareDto>(await ShareService.update(c.var.user, paramUuid(c, "id"), paramInt(c, "userId"), body, clientIp(c)));
  });

  /**
   * DELETE /api/servers/:id/shares/:userId → OkResponse. Owner level, or any level for your own share.
   */
  router.delete("/:userId", async (c) => {
    await ShareService.remove(c.var.user, paramUuid(c, "id"), paramInt(c, "userId"), clientIp(c));
    return c.json<OkResponse>({ ok: true });
  });
}

export default ShareController;
