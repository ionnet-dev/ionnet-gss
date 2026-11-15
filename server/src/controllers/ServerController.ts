import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { ConsoleInputBody, CreateServerBody, StopServerBody, UpdateServerBody } from "@shared/api/servers.ts";
import { type AppEnv, paramUuid, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { User } from "../models/index.ts";
import { GameServerService } from "../servers/GameServerService.ts";

/**
 * `/api/servers`. Thin: validate the shape, call `GameServerService`, answer. Access checks live in the service.
 * Audit: `server.created`, `server.updated`, `server.started`, `server.stopped`, `server.restarted`,
 * `server.reinstalled`, `server.deleted`.
 */
export namespace ServerController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/servers → GameServerDto[].
   */
  router.get("/", async (c) => {
    return c.json(await GameServerService.list(c.var.user));
  });

  /**
   * POST /api/servers  CreateServerBody → 201 GameServerDetailResponse. SERVERS_CREATE. 400 variables, 403 host not
   * granted, 409 quota / capacity / ports / host offline.
   */
  router.post("/", User.$middleware({ permissions: ["SERVERS_CREATE"] }), async (c) => {
    const body = await readBody<CreateServerBody>(c);
    throw HttpError.notImplemented("POST /api/servers"); // TODO(builder): C
  });

  /**
   * GET /api/servers/:id → GameServerDetailResponse.
   */
  router.get("/:id", async (c) => {
    return c.json(await GameServerService.detail(c.var.user, paramUuid(c, "id")));
  });

  /**
   * PATCH /api/servers/:id  UpdateServerBody → UpdateServerResponse. 409 unless stopped.
   */
  router.patch("/:id", async (c) => {
    const body = await readBody<UpdateServerBody>(c);
    throw HttpError.notImplemented("PATCH /api/servers/:id"); // TODO(builder): C
  });

  /**
   * POST /api/servers/:id/start → GameServerDto. 409 offline, already running, over disk limit.
   */
  router.post("/:id/start", async (c) => {
    return c.json(await GameServerService.start(c.var.user, paramUuid(c, "id")));
  });

  /**
   * POST /api/servers/:id/stop  StopServerBody → GameServerDto.
   */
  router.post("/:id/stop", async (c) => {
    const body = await readBody<StopServerBody>(c);
    return c.json(await GameServerService.stop(c.var.user, paramUuid(c, "id"), body.kill === true));
  });

  /**
   * POST /api/servers/:id/restart → GameServerDto.
   */
  router.post("/:id/restart", async (c) => {
    return c.json(await GameServerService.restart(c.var.user, paramUuid(c, "id")));
  });

  /**
   * POST /api/servers/:id/reinstall → GameServerDto. 409 while running.
   */
  router.post("/:id/reinstall", async (c) => {
    return c.json(await GameServerService.reinstall(c.var.user, paramUuid(c, "id")));
  });

  /**
   * DELETE /api/servers/:id?keepData=true → OkResponse.
   */
  router.delete("/:id", async (c) => {
    await GameServerService.remove(c.var.user, paramUuid(c, "id"), c.req.query("keepData") === "true");
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * GET /api/servers/:id/console?limit=200 → ConsoleBacklogResponse (limit 1–1000).
   */
  router.get("/:id/console", async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    return c.json(await GameServerService.backlog(c.var.user, paramUuid(c, "id"), limit));
  });

  /**
   * POST /api/servers/:id/console  ConsoleInputBody → OkResponse. 409 unless running/starting.
   */
  router.post("/:id/console", async (c) => {
    const body = await readBody<ConsoleInputBody>(c);
    throw HttpError.notImplemented("POST /api/servers/:id/console"); // TODO(builder): C (validate line: string, ≤ 1024 chars, no newlines)
  });
}

export default ServerController;
