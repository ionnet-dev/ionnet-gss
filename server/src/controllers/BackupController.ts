import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateBackupBody } from "@shared/api/backups.ts";
import { type AppEnv, clientIp, paramInt, paramUuid, readOptionalBody } from "../lib/http.ts";
import { AuditLog, User } from "../models/index.ts";
import { BackupService } from "../servers/BackupService.ts";

/**
 * `/api/servers/:id/backups` (M4), mounted by `ApiController`. Thin: parse, call `BackupService`. Audit: the requests
 * here (`backup.created`, `backup.deleted`, `server.restore_started`, with the caller's IP); the service audits what
 * finishes later (`backup.finished`, `server.restored`).
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
    const serverId = paramUuid(c, "id");
    const body = await readOptionalBody<CreateBackupBody>(c);
    const backup = await BackupService.create(c.var.user, serverId, body);
    await AuditLog.record({ action: "backup.created", actorId: c.var.user.id, serverId, ip: clientIp(c), details: { backupId: backup.id, name: backup.name } });
    return c.json(backup, 202);
  });

  /**
   * DELETE /api/servers/:id/backups/:backupId → OkResponse.
   */
  router.delete("/:backupId", async (c) => {
    const serverId = paramUuid(c, "id");
    const backupId = paramInt(c, "backupId");
    await BackupService.remove(c.var.user, serverId, backupId);
    await AuditLog.record({ action: "backup.deleted", actorId: c.var.user.id, serverId, ip: clientIp(c), details: { backupId } });
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/servers/:id/backups/:backupId/restore → 202 RestoreBackupResponse.
   */
  router.post("/:backupId/restore", async (c) => {
    const serverId = paramUuid(c, "id");
    const backupId = paramInt(c, "backupId");
    const response = await BackupService.restore(c.var.user, serverId, backupId);
    await AuditLog.record({ action: "server.restore_started", actorId: c.var.user.id, serverId, ip: clientIp(c), details: { backupId } });
    return c.json(response, 202);
  });

  /**
   * POST /api/servers/:id/backups/:backupId/download → DownloadTicketResponse.
   */
  router.post("/:backupId/download", async (c) => {
    return c.json(await BackupService.downloadTicket(c.var.user, paramUuid(c, "id"), paramInt(c, "backupId")));
  });
}

export default BackupController;
