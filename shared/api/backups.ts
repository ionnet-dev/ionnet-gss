/**
 * `/api/servers/:id/backups` (M4). Access: `manage` (owner, SERVERS_MANAGE_ALL, or a share with role `manage`); 404
 * otherwise. Archives live on the server's host (`<server>/backups/<id>.tar.zst`); one backup or restore runs per
 * server at a time. Progress arrives as `backup.progress` on the `server:<id>` topic, changes as `backup.updated`.
 */
import type { BackupOperation } from "../protocol/protocol.gen.ts";

export type BackupStatus = "pending" | "running" | "done" | "failed";

export interface BackupDto {
  id: number;
  name: string;
  status: BackupStatus;
  sizeBytes: number | null; // Archive size once done.
  error: string | null; // Why it failed.
  createdBy: { id: number; username: string } | null; // null = a schedule (later milestone).
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * The backup or restore the server runs right now.
 */
export interface BackupOperationDto {
  backupId: number;
  operation: BackupOperation;
  bytes: number; // Uncompressed bytes processed so far.
  totalBytes: number | null; // Estimate; null when unknown.
  startedAt: string;
}

/**
 * `GET /api/servers/:id/backups`, newest first.
 */
export interface BackupListResponse {
  backups: BackupDto[];
  operation: BackupOperationDto | null;
  /**
   * How many backups the owner's quota allows for this server and how many count against it (every status but
   * `failed`). M4 counts per server; the user-wide quota is M5. `max` is null for an admin owner, who has no limit.
   */
  limit: { max: number | null; used: number }; // max null = unlimited (an admin owner).
}

/**
 * `POST /api/servers/:id/backups` → 202 `BackupDto` (status `running`). 409: another backup or restore runs, the
 * server is creating/installing/deleting, the limit is reached, or the host is offline; 507 the host's disk is
 * too full.
 */
export interface CreateBackupBody {
  name?: string; // Default: "Backup <date time>". At most 128 characters.
}

/**
 * `POST /api/servers/:id/backups/:backupId/restore` → 202 `OkResponse`. Only while the server is stopped, crashed or
 * install_failed (409), only a `done` backup (409). The server's data is replaced when it finishes; the game stays
 * stopped.
 */
export interface RestoreBackupResponse {
  ok: true;
  operation: BackupOperationDto;
}
