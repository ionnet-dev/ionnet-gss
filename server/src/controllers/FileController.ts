import { type Context, Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateFolderBody, DeleteFilesBody, DownloadFileBody, RenameFileBody } from "@shared/api/files.ts";
import { type AppEnv, clientIp, paramUuid, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, User } from "../models/index.ts";
import { FileService } from "../servers/FileService.ts";

/**
 * `/api/servers/:id/files` (M4), mounted by `ApiController`. Thin: parse, call `FileService`, answer. Access (`manage`)
 * lives in the service. Audit: `files.written`, `files.uploaded`, `files.renamed`, `files.deleted`, `files.folder_created`
 * (details: the paths). Reads, lists and downloads aren't audited.
 *
 * Two routes take raw bodies instead of JSON, so `App.ts` gives them their own body limits (`BODY_PATHS`): the upload
 * is streamed (no panel limit; UPLOAD_MAX_MB is checked against Content-Length and while streaming) and the editor's
 * save is plain text up to FILE_TEXT_MAX_BYTES.
 */
async function audit(c: Context<AppEnv>, action: string, serverId: string, details: Record<string, unknown>): Promise<void> {
  await AuditLog.record({ action, actorId: c.var.user.id, serverId, hostId: null, ip: clientIp(c), details });
}

export namespace FileController {
  export const router = new Hono<AppEnv>();

  /**
   * Paths (below `/api`) whose bodies aren't JSON, for `App.ts`'s body limits.
   */
  export const BODY_PATHS = {
    UPLOAD: /^\/api\/servers\/[^/]+\/files\/upload$/,
    CONTENT: /^\/api\/servers\/[^/]+\/files\/content$/,
  } as const;

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/files?path= → FileListResponse.
   */
  router.get("/", async (c) => {
    const path = FileService.cleanPath(c.req.query("path") ?? "");
    return c.json(await FileService.list(c.var.user, paramUuid(c, "id"), path));
  });

  /**
   * GET /api/servers/:id/files/content?path= → FileContentResponse. 413 too large, 415 not text.
   */
  router.get("/content", async (c) => {
    const path = FileService.cleanPath(c.req.query("path"));
    return c.json(await FileService.read(c.var.user, paramUuid(c, "id"), path));
  });

  /**
   * PUT /api/servers/:id/files/content?path=&modifiedAt=  text/plain body → FileEntryDto. 409 changed since loaded.
   */
  router.put("/content", async (c) => {
    const serverId = paramUuid(c, "id");
    const path = FileService.cleanPath(c.req.query("path"));
    const entry = await FileService.write(c.var.user, serverId, path, await c.req.text(), c.req.query("modifiedAt") ?? null);
    await audit(c, "files.written", serverId, { path });
    return c.json(entry);
  });

  /**
   * POST /api/servers/:id/files/folder  CreateFolderBody → 201 FileEntryDto.
   */
  router.post("/folder", async (c) => {
    const serverId = paramUuid(c, "id");
    const body = await readBody<CreateFolderBody>(c);
    const path = FileService.cleanPath(body.path);
    const entry = await FileService.mkdir(c.var.user, serverId, path);
    await audit(c, "files.folder_created", serverId, { path });
    return c.json(entry, 201);
  });

  /**
   * POST /api/servers/:id/files/rename  RenameFileBody → FileEntryDto.
   */
  router.post("/rename", async (c) => {
    const serverId = paramUuid(c, "id");
    const body = await readBody<RenameFileBody>(c);
    const from = FileService.cleanPath(body.from, "from");
    const to = FileService.cleanPath(body.to, "to");
    const entry = await FileService.rename(c.var.user, serverId, from, to, body.overwrite === true);
    await audit(c, "files.renamed", serverId, { from, to });
    return c.json(entry);
  });

  /**
   * POST /api/servers/:id/files/delete  DeleteFilesBody → OkResponse.
   */
  router.post("/delete", async (c) => {
    const serverId = paramUuid(c, "id");
    const body = await readBody<DeleteFilesBody>(c);
    if (!Array.isArray(body.paths) || body.paths.length === 0) throw HttpError.badRequest("\"paths\" must list the files and folders to delete.");
    const paths = body.paths.map((path, i) => FileService.cleanPath(path, `paths[${i}]`));
    await FileService.remove(c.var.user, serverId, paths);
    await audit(c, "files.deleted", serverId, { paths });
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * PUT /api/servers/:id/files/upload?path=&overwrite=true  raw body → 201 FileEntryDto. 411 without Content-Length,
   * 413 over UPLOAD_MAX_MB, 507 no space.
   */
  router.put("/upload", async (c) => {
    const serverId = paramUuid(c, "id");
    const path = FileService.cleanPath(c.req.query("path"));
    const length = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(411, "Send the file with a Content-Length header.");
    const body = c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const entry = await FileService.upload(c.var.user, serverId, path, c.req.query("overwrite") === "true", length, body, c.req.raw.signal);
    await audit(c, "files.uploaded", serverId, { path, size: length });
    return c.json(entry, 201);
  });

  /**
   * POST /api/servers/:id/files/download  DownloadFileBody → DownloadTicketResponse.
   */
  router.post("/download", async (c) => {
    const body = await readBody<DownloadFileBody>(c);
    return c.json(await FileService.downloadTicket(c.var.user, paramUuid(c, "id"), FileService.cleanPath(body.path)));
  });
}

export default FileController;
