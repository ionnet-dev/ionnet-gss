import { BACKUP_OPERATION_VALUES, type BackupProgress } from "@shared/protocol/protocol.gen.ts";
import { BackupService } from "../../../servers/BackupService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fields `backup.progress` and `backup.finished` share, checked (serverId UUID, backupId positive integer,
 * operation in BACKUP_OPERATION_VALUES, `at` a date). Exported for `backupFinished.ts`.
 * @throws AgentRequestError `bad_request` naming the bad field.
 */
export function checkBackupEvent(data: unknown, what: string): Record<string, unknown> & Pick<BackupProgress, "serverId" | "backupId" | "operation" | "at"> {
  const event = requireObject<Record<string, unknown>>(data, what);
  if (typeof event.serverId !== "string" || !UUID_PATTERN.test(event.serverId)) throw new AgentRequestError("bad_request", `${what}.serverId must be a UUID.`);
  if (!Number.isSafeInteger(event.backupId) || (event.backupId as number) <= 0) throw new AgentRequestError("bad_request", `${what}.backupId must be a positive whole number.`);
  if (!(BACKUP_OPERATION_VALUES as readonly unknown[]).includes(event.operation)) throw new AgentRequestError("bad_request", `${what}.operation must be one of ${BACKUP_OPERATION_VALUES.join(", ")}.`);
  const at = typeof event.at === "string" ? event.at : "";
  if (Number.isNaN(Date.parse(at))) throw new AgentRequestError("bad_request", `${what}.at must be a date.`);
  return { ...event, serverId: event.serverId.toLowerCase(), backupId: event.backupId as number, operation: event.operation as BackupProgress["operation"], at };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * `backup.progress` (M4): shape-check (serverId UUID, backupId positive integer, operation in BACKUP_OPERATION_VALUES,
 * bytes non-negative integer, totalBytes integer or null), then `BackupService.applyProgress`.
 */
export async function handleBackupProgress(conn: AgentConnection, data: BackupProgress): Promise<void> {
  if (!conn.hostId) return;
  const event = checkBackupEvent(data, "backup.progress");
  if (!isCount(event.bytes)) throw new AgentRequestError("bad_request", "backup.progress.bytes must be a whole number of at least 0.");
  const totalBytes = event.totalBytes ?? null;
  if (totalBytes !== null && !isCount(totalBytes)) throw new AgentRequestError("bad_request", "backup.progress.totalBytes must be a whole number of at least 0, or null.");
  await BackupService.applyProgress(conn.hostId, {
    serverId: event.serverId,
    backupId: event.backupId,
    operation: event.operation,
    bytes: event.bytes,
    totalBytes,
    at: event.at,
  });
}
