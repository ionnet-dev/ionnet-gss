import type { BackupFinished } from "@shared/protocol/protocol.gen.ts";
import { BackupService } from "../../../servers/BackupService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { checkBackupEvent } from "./backupProgress.ts";

/**
 * Most characters of `error` that are stored.
 */
const MAX_ERROR = 2000;

/**
 * `backup.finished` (M4): shape-check (as `backup.progress`, plus ok boolean, sizeBytes integer or null, error string
 * or null cut to 2000 characters), then `BackupService.applyFinished`.
 */
export async function handleBackupFinished(conn: AgentConnection, data: BackupFinished): Promise<void> {
  if (!conn.hostId) return;
  const event = checkBackupEvent(data, "backup.finished");
  if (typeof event.ok !== "boolean") throw new AgentRequestError("bad_request", "backup.finished.ok must be true or false.");
  const sizeBytes = event.sizeBytes ?? null;
  if (sizeBytes !== null && !(Number.isSafeInteger(sizeBytes) && (sizeBytes as number) >= 0)) {
    throw new AgentRequestError("bad_request", "backup.finished.sizeBytes must be a whole number of at least 0, or null.");
  }
  const error = event.error ?? null;
  if (error !== null && typeof error !== "string") throw new AgentRequestError("bad_request", "backup.finished.error must be a string or null.");
  await BackupService.applyFinished(conn.hostId, {
    serverId: event.serverId,
    backupId: event.backupId,
    operation: event.operation,
    ok: event.ok,
    sizeBytes: sizeBytes as number | null,
    error: error === null ? null : error.slice(0, MAX_ERROR),
    at: event.at,
  });
}
