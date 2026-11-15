import { Card, CardBody, EmptyState } from "@ionnet/iontronic/react";
import { Archive } from "@ionnet/iontronic/icons";
import type { GameServerDto } from "@shared/api/servers.ts";

export interface BackupListProps {
  server: GameServerDto;
}

/**
 * The Backups tab (M4): `BackupApi.useBackups` list (name, status badge, size, created by, when), "Back up now"
 * (optional name; disabled while an operation runs or at the limit, showing `limit.used`/`limit.max`), live progress
 * of the running backup or restore (`BackupApi.useProgress`, `Progress` with bytes/totalBytes), download, delete
 * (AlertDialog), restore (AlertDialog that says the current files are replaced; enabled only while the server is
 * stopped, crashed or install_failed).
 */
export default function BackupList(props: BackupListProps) {
  const { server } = props;
  // TODO(builder)
  return (
    <Card>
      <CardBody>
        <EmptyState icon={Archive} title="Backups" description={`Backups of ${server.name} aren't built yet.`} />
      </CardBody>
    </Card>
  );
}
