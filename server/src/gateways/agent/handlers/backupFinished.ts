import type { BackupFinished } from "@shared/protocol/protocol.gen.ts";
import { BackupService } from "../../../servers/BackupService.ts";
import type { AgentConnection } from "../AgentConnection.ts";

/**
 * `backup.finished` (M4): shape-check (as `backup.progress`, plus ok boolean, sizeBytes integer or null, error string
 * or null cut to 2000 characters), then `BackupService.applyFinished`.
 */
export async function handleBackupFinished(conn: AgentConnection, data: BackupFinished): Promise<void> {
  if (!conn.hostId) return;
  // TODO(builder): validate as documented before passing on.
  await BackupService.applyFinished(conn.hostId, data);
}
