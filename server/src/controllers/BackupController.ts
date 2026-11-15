import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateBackupBody } from "@shared/api/backups.ts";
import { type AppEnv, paramInt, paramUuid, readOptionalBody } from "../lib/http.ts";
import { User } from "../models/index.ts";
import { BackupService } from "../servers/BackupService.ts";

/**
 * `/api/servers/:id/backups` (M4), mounted by `ApiController`. Thin: parse, call `BackupService`. Audit (in the
 * service, because finishing is asynchronous): `backup.created`, `backup.deleted`, `server.restore_started`,
 * `server.restored`.
 */
export namespace BackupController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/backups → BackupListResponse.
   */
  router.get("/", async (c) => {
    return c.json(await BackupService.list(c.var.user, paramUuid(c, "id")));
  });

  /**
   * POST /api/servers/:id/backups  CreateBackupBody → 202 BackupDto.
   */
  router.post("/", async (c) => {
    const body = await readOptionalBody<CreateBackupBody>(c);
    return c.json(await BackupService.create(c.var.user, paramUuid(c, "id"), body), 202);
  });

  /**
   * DELETE /api/servers/:id/backups/:backupId → OkResponse.
   */
  router.delete("/:backupId", async (c) => {
    await BackupService.remove(c.var.user, paramUuid(c, "id"), paramInt(c, "backupId"));
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/servers/:id/backups/:backupId/restore → 202 RestoreBackupResponse.
   */
  router.post("/:backupId/restore", async (c) => {
    return c.json(await BackupService.restore(c.var.user, paramUuid(c, "id"), paramInt(c, "backupId")), 202);
  });

  /**
   * POST /api/servers/:id/backups/:backupId/download → DownloadTicketResponse.
   */
  router.post("/:backupId/download", async (c) => {
    return c.json(await BackupService.downloadTicket(c.var.user, paramUuid(c, "id"), paramInt(c, "backupId")));
  });
}

export default BackupController;
