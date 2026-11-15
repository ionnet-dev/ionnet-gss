import type { BackupProgress } from "@shared/protocol/protocol.gen.ts";
import { BackupService } from "../../../servers/BackupService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `backup.progress` (M4): shape-check (serverId UUID, backupId positive integer, operation in BACKUP_OPERATION_VALUES,
 * bytes non-negative integer, totalBytes integer or null), then `BackupService.applyProgress`.
 */
export async function handleBackupProgress(conn: AgentConnection, data: BackupProgress): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): validate as documented before passing on.
  await BackupService.applyProgress(conn.hostId, data);
}
