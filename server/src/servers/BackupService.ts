/**
 * Backups and restore (M4). The panel keeps the rows (`backups`) and the per-server limit; the agent does the work
 * (backup.json) and reports `backup.progress` / `backup.finished`. One operation per server at a time, known here in
 * memory (`_operations`, from the create/restore answers, progress events and every hello's
 * `ServerStatus.operation`).
 *
 *   create   ServerAccess(manage) → state not creating/installing/deleting (409) → no operation (409) →
 *            assertSlot (409) → row `pending` (file = `backups/<id>.tar.zst`) → backup.create → row `running`,
 *            startedAt → push `backup.updated`. A refusal destroys the row and rethrows (409/507 from the agent).
 *   finished `done` + sizeBytes + finishedAt, or `failed` + error; push `backup.updated`; audit `backup.finished`.
 *   restore  stopped/crashed/install_failed only (409), backup `done` (409), no operation → backup.restore → push
 *            `backup.updated`; on finish audit `server.restored` (ok or not) and push `server.updated`.
 *   delete   not the running one (409) → backup.delete (idempotent on the agent) → destroy row. Failed rows too (their
 *            file may exist if the agent died right after finishing). Host offline → 409.
 *   hello    reconcile: a `pending`/`running` row the agent doesn't name in `ServerStatus.operation` → `failed`
 *            ("The host's agent restarted while the backup ran."); a named one is (re)stored in `_operations`.
 *
 * Quota seam: `assertSlot` counts this server's non-failed backups against the owner's `maxBackups`
 * (DEFAULT_QUOTA_BACKUPS when null); admins pass. M5 replaces it with the user-wide `Quota.assertFits`.
 */
import type { BackupDto, BackupListResponse, BackupOperationDto, CreateBackupBody, RestoreBackupResponse } from "@shared/api/backups.ts";
import type { DownloadTicketResponse } from "@shared/api/files.ts";
import type { BackupFinished, BackupProgress, ServerStatus } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { Backup, GameServer, User } from "../models/index.ts";

export namespace BackupService {
  /**
   * The running operation per server id.
   */
  const _operations = new Map<string, BackupOperationDto>();

  export async function list(user: User, serverId: string): Promise<BackupListResponse> {
    throw HttpError.notImplemented("BackupService.list"); // TODO(builder)
  }

  export async function create(user: User, serverId: string, body: Partial<CreateBackupBody>): Promise<BackupDto> {
    throw HttpError.notImplemented("BackupService.create"); // TODO(builder)
  }

  export async function remove(user: User, serverId: string, backupId: number): Promise<void> {
    throw HttpError.notImplemented("BackupService.remove"); // TODO(builder)
  }

  export async function restore(user: User, serverId: string, backupId: number): Promise<RestoreBackupResponse> {
    throw HttpError.notImplemented("BackupService.restore"); // TODO(builder)
  }

  /**
   * A download ticket for a `done` backup, named `<server name>-<backup id>.tar.zst` (409 otherwise).
   */
  export async function downloadTicket(user: User, serverId: string, backupId: number): Promise<DownloadTicketResponse> {
    throw HttpError.notImplemented("BackupService.downloadTicket"); // TODO(builder)
  }

  /**
   * The operation a server runs right now, or null.
   */
  export function operationOf(serverId: string): BackupOperationDto | null {
    return _operations.get(serverId) ?? null;
  }

  /**
   * `backup.progress`: update `_operations` and push `backup.progress` to `server:<id>`. Ignores other hosts' servers.
   */
  export async function applyProgress(hostId: string, progress: BackupProgress): Promise<void> {
    // TODO(builder): implement. A no-op until then (runs on the live agent path).
  }

  /**
   * `backup.finished`: settle the row (see the module doc), clear `_operations`, push.
   */
  export async function applyFinished(hostId: string, finished: BackupFinished): Promise<void> {
    // TODO(builder): implement. A no-op until then (runs on the live agent path).
  }

  /**
   * After a hello: align rows and `_operations` with the agent's `ServerStatus.operation`s.
   */
  export async function reconcile(hostId: string, servers: ServerStatus[]): Promise<void> {
    // TODO(builder): implement. A no-op until then (runs on every hello).
  }

  /**
   * Refuse a new backup when the server already holds the owner's `maxBackups` (non-failed rows). The M5 seam.
   * @throws HttpError 409 "This server already has 5 backups, the most your quota allows. Delete an old one first."
   */
  export async function assertSlot(server: GameServer): Promise<{ max: number; used: number }> {
    throw new Error("Not implemented."); // TODO(builder): M4 per-server count; M5 → Quota.assertFits({ backups: 1 }).
  }

  /**
   * The client shape of a row (createdBy included when loaded).
   */
  export function toDto(backup: Backup): BackupDto {
    throw new Error("Not implemented."); // TODO(builder)
  }
}

export default BackupService;
