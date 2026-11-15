import { Card, CardBody, EmptyState } from "@ionnet/iontronic/react";
import { FolderOpen } from "@ionnet/iontronic/icons";
import type { GameServerDto } from "@shared/api/servers.ts";

export interface FileManagerProps {
  server: GameServerDto;
}

/**
 * The Files tab (M4): breadcrumb of the current folder, the listing (`Table`: name, size, modified; folders first),
 * open a text file in `FileEditor` (same folder), upload (multiple files, progress per file, cancel; asks before
 * overwriting on 409), download (ticket → browser download), rename/move, delete (AlertDialog), new folder. All data
 * through `FileApi`; failures through `useNotify`. Disabled with an explanation while the host is offline.
 */
export default function FileManager(props: FileManagerProps) {
  const { server } = props;
  // TODO(builder)
  return (
    <Card>
      <CardBody>
        <EmptyState icon={FolderOpen} title="Files" description={`The file manager for ${server.name} isn't built yet.`} />
      </CardBody>
    </Card>
  );
}
