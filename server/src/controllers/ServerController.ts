import { type Context, Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { ConsoleInputBody, CreateServerBody, GameServerDto, StopServerBody, UpdateServerBody } from "@shared/api/servers.ts";
import { CONSOLE_BACKLOG_MAX_LINES } from "@shared/protocol/protocol.gen.ts";
import { type AppEnv, clientIp, paramUuid, readBody, readOptionalBody } from "../lib/http.ts";
import { AuditLog, User } from "../models/index.ts";
import { GameServerService } from "../servers/GameServerService.ts";

/**
 * `/api/servers`. Thin: validate the shape, call `GameServerService`, answer. Access checks live in the service.
 * Audit: `server.created`, `server.updated`, `server.started`, `server.stopped`, `server.restarted`,
 * `server.reinstalled`, `server.deleted`. `allowPrivateNetwork` is in the details of a create and of an update that
 * sent it.
 */
/**
 * One audit entry for something a user did to a server.
 */
async function audit(c: Context<AppEnv>, action: string, serverId: string, hostId: string | null, details?: Record<string, unknown>): Promise<void> {
  await AuditLog.record({ action, actorId: c.var.user.id, serverId, hostId, ip: clientIp(c), details: details ?? null });
}

/**
 * Audit a lifecycle action on the server the DTO describes.
 */
async function auditDto(c: Context<AppEnv>, action: string, server: GameServerDto): Promise<void> {
  await audit(c, action, server.id, server.host.id, { name: server.name });
}

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
    const server = await GameServerService.create(c.var.user, body as CreateServerBody);
    await audit(c, "server.created", server.id, server.host.id, { name: server.name, game: server.definition.gameId, allowPrivateNetwork: server.allowPrivateNetwork });
    return c.json(server, 201);
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
    const result = await GameServerService.update(c.var.user, paramUuid(c, "id"), body);
    const details: Record<string, unknown> = { changes: Object.keys(body).filter((key) => key !== "variables"), variables: Object.keys(body.variables ?? {}) };
    if (body.allowPrivateNetwork !== undefined) details.allowPrivateNetwork = result.server.allowPrivateNetwork;
    await audit(c, "server.updated", result.server.id, result.server.host.id, details);
    return c.json(result);
  });

  /**
   * POST /api/servers/:id/start → GameServerDto. 409 offline, already running, over disk limit.
   */
  router.post("/:id/start", async (c) => {
    const server = await GameServerService.start(c.var.user, paramUuid(c, "id"));
    await auditDto(c, "server.started", server);
    return c.json(server);
  });

  /**
   * POST /api/servers/:id/stop  StopServerBody → GameServerDto.
   */
  router.post("/:id/stop", async (c) => {
    const body = await readOptionalBody<StopServerBody>(c);
    const server = await GameServerService.stop(c.var.user, paramUuid(c, "id"), body.kill === true);
    await audit(c, "server.stopped", server.id, server.host.id, { name: server.name, kill: body.kill === true });
    return c.json(server);
  });

  /**
   * POST /api/servers/:id/restart → GameServerDto.
   */
  router.post("/:id/restart", async (c) => {
    const server = await GameServerService.restart(c.var.user, paramUuid(c, "id"));
    await auditDto(c, "server.restarted", server);
    return c.json(server);
  });

  /**
   * POST /api/servers/:id/reinstall → GameServerDto. 409 while running.
   */
  router.post("/:id/reinstall", async (c) => {
    const server = await GameServerService.reinstall(c.var.user, paramUuid(c, "id"));
    await auditDto(c, "server.reinstalled", server);
    return c.json(server);
  });

  /**
   * DELETE /api/servers/:id?keepData=true → OkResponse: 200 when the host confirmed, 202 when it didn't answer in
   * time (the server stays `deleting` and the delete is retried).
   */
  router.delete("/:id", async (c) => {
    const id = paramUuid(c, "id");
    const server = await GameServerService.detail(c.var.user, id);
    const keepData = c.req.query("keepData") === "true";
    const finished = await GameServerService.remove(c.var.user, id, keepData);
    await audit(c, "server.deleted", id, server.host.id, { name: server.name, keepData, confirmed: finished });
    return c.json<OkResponse>({ ok: true }, finished ? 200 : 202);
  });

  /**
   * GET /api/servers/:id/console?limit=200&before=<seq> → ConsoleBacklogResponse (limit 1–1000; `before` pages back
   * from the first `seq` of the previous page; `more` = older lines exist).
   */
  router.get("/:id/console", async (c) => {
    const limit = Math.min(CONSOLE_BACKLOG_MAX_LINES, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    const before = Math.max(0, Math.floor(Number(c.req.query("before") ?? 0) || 0));
    return c.json(await GameServerService.backlog(c.var.user, paramUuid(c, "id"), limit, before));
  });

  /**
   * POST /api/servers/:id/console  ConsoleInputBody → OkResponse. 409 unless running/starting.
   */
  router.post("/:id/console", async (c) => {
    const body = await readBody<ConsoleInputBody>(c);
    await GameServerService.input(c.var.user, paramUuid(c, "id"), body.line as string);
    return c.json<OkResponse>({ ok: true });
  });
}

export default ServerController;
