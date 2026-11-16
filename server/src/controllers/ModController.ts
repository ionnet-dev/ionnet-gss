import { type Context, Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type {
  ApplyModPackBody,
  DeleteModsBody,
  InstallModBody,
  ModInstallResponse,
  ModPackPreviewDto,
  ModsResponse,
  ModSearchResponse,
  ModVersionDto,
  SetModStateBody,
  UpdateModsBody,
  UploadModResponse,
} from "@shared/api/mods.ts";
import { type AppEnv, clientIp, paramUuid, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, User } from "../models/index.ts";
import { ModPackService } from "../servers/ModPackService.ts";
import { ModService } from "../servers/ModService.ts";

/**
 * `/api/servers/:id/mods` (shared/api/mods.ts), mounted by `ApiController`. Thin: parse, call `ModService`, answer.
 * Access (`manage`) lives in the services. Audit: `mods.uploaded`, `mods.state`, `mods.deleted`, `mods.installed`,
 * `mods.pack_applied` (details: the folder key, mod names or counts). Lists, searches, version lists and pack
 * previews aren't audited.
 *
 * The upload and the pack preview take raw bodies, so `App.ts` streams them without a body limit (`BODY_PATHS`);
 * UPLOAD_MAX_MB / MOD_PACK_MAX_MB are checked against Content-Length and while streaming.
 */
async function audit(c: Context<AppEnv>, action: string, serverId: string, details: Record<string, unknown>): Promise<void> {
  await AuditLog.record({ action, actorId: c.var.user.id, serverId, hostId: null, ip: clientIp(c), details });
}

export namespace ModController {
  export const router = new Hono<AppEnv>();

  /**
   * Paths (below `/api`) whose bodies aren't JSON, for `App.ts`'s body limits.
   */
  export const BODY_PATHS = {
    UPLOAD: /^\/api\/servers\/[^/]+\/mods\/[^/]+\/upload$/,
    PACKS: /^\/api\/servers\/[^/]+\/mods\/[^/]+\/packs$/,
  } as const;

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/mods → ModsResponse. 404 when no mod folder applies.
   */
  router.get("/", async (c) => {
    return c.json<ModsResponse>(await ModService.get(c.var.user, paramUuid(c, "id")));
  });

  /**
   * POST (or PUT) /api/servers/:id/mods/:folder/upload?name=&overwrite=1  raw body → 201 UploadModResponse. 400 a name
   * that doesn't fit the folder, 409 "already exists", 411 without Content-Length, 413 over UPLOAD_MAX_MB.
   */
  router.on(["POST", "PUT"], "/:folder/upload", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const name = c.req.query("name");
    const overwrite = c.req.query("overwrite") === "1" || c.req.query("overwrite") === "true";
    const { length, body } = rawBody(c);
    const mod = await ModService.upload(c.var.user, serverId, folder, name, overwrite, length, body, c.req.raw.signal);
    await audit(c, "mods.uploaded", serverId, { folder, name: mod.name, size: length });
    return c.json<UploadModResponse>(mod, 201);
  });

  /**
   * POST /api/servers/:id/mods/:folder/state  SetModStateBody → OkResponse.
   */
  router.post("/:folder/state", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const body = await readBody<SetModStateBody>(c);
    await ModService.setState(c.var.user, serverId, folder, body);
    await audit(c, "mods.state", serverId, { folder, names: body.names, enabled: body.enabled });
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/servers/:id/mods/:folder/delete  DeleteModsBody → OkResponse.
   */
  router.post("/:folder/delete", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const body = await readBody<DeleteModsBody>(c);
    const { deleted } = await ModService.remove(c.var.user, serverId, folder, body);
    await audit(c, "mods.deleted", serverId, { folder, names: body.names, entries: deleted }); // entries > names: copies in both folders.
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * GET /api/servers/:id/mods/:folder/catalog/:provider/search?query=&offset=&limit= → ModSearchResponse.
   */
  router.get("/:folder/catalog/:provider/search", async (c) => {
    const params = { query: c.req.query("query"), offset: c.req.query("offset"), limit: c.req.query("limit") };
    return c.json<ModSearchResponse>(await ModService.search(c.var.user, paramUuid(c, "id"), c.req.param("folder"), c.req.param("provider"), params));
  });

  /**
   * GET /api/servers/:id/mods/:folder/catalog/:provider/projects/:projectId/versions → ModVersionDto[] (a plain array).
   */
  router.get("/:folder/catalog/:provider/projects/:projectId/versions", async (c) => {
    const { folder, provider, projectId } = c.req.param();
    return c.json<ModVersionDto[]>(await ModService.versions(c.var.user, paramUuid(c, "id"), folder, provider, projectId));
  });

  /**
   * POST /api/servers/:id/mods/:folder/install  InstallModBody → ModInstallResponse.
   */
  router.post("/:folder/install", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const res = await ModService.install(c.var.user, serverId, folder, await readBody<InstallModBody>(c));
    await audit(c, "mods.installed", serverId, { folder, names: res.installed.map((mod) => mod.name) });
    return c.json<ModInstallResponse>(res);
  });

  /**
   * POST /api/servers/:id/mods/:folder/update  UpdateModsBody → ModInstallResponse.
   */
  router.post("/:folder/update", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const res = await ModService.update(c.var.user, serverId, folder, await readBody<UpdateModsBody>(c));
    if (res.installed.length > 0) await audit(c, "mods.installed", serverId, { folder, names: res.installed.map((mod) => mod.name), update: true });
    return c.json<ModInstallResponse>(res);
  });

  /**
   * POST (or PUT) /api/servers/:id/mods/:folder/packs?name=  raw pack → ModPackPreviewDto. 400 not a pack the folder
   * takes, 404 no pack import, 411 without Content-Length, 413 over MOD_PACK_MAX_MB.
   */
  router.on(["POST", "PUT"], "/:folder/packs", async (c) => {
    const { length, body } = rawBody(c);
    const preview = await ModPackService.preview(c.var.user, paramUuid(c, "id"), c.req.param("folder"), c.req.query("name"), length, body, c.req.raw.signal);
    return c.json<ModPackPreviewDto>(preview);
  });

  /**
   * POST /api/servers/:id/mods/:folder/packs/:token/apply  ApplyModPackBody → ModInstallResponse. 404 unknown token.
   */
  router.post("/:folder/packs/:token/apply", async (c) => {
    const serverId = paramUuid(c, "id");
    const folder = c.req.param("folder");
    const result = await ModPackService.apply(c.var.user, serverId, folder, c.req.param("token"), await readBody<ApplyModPackBody>(c));
    await audit(c, "mods.pack_applied", serverId, {
      folder,
      pack: result.name,
      installed: result.response.installed.length,
      skipped: result.response.skipped.length,
      overrides: result.overrides,
    });
    return c.json<ModInstallResponse>(result.response);
  });

  /**
   * A raw request body and its Content-Length.
   * @throws HttpError 411 without a Content-Length.
   */
  function rawBody(c: Context<AppEnv>): { length: number; body: ReadableStream<Uint8Array> } {
    const length = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(411, "Send the file with a Content-Length header.");
    return { length, body: c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }) };
  }
}

export default ModController;
