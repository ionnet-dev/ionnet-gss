import { type FormEvent, useState } from "react";
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  EmptyState,
  Input,
  Menu,
  Progress,
  Spinner,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ionnet/iontronic/react";
import { Archive, ArchiveRestore, Download, Ellipsis, Plus, Trash2 } from "@ionnet/iontronic/icons";
import type { BackupDto, BackupOperationDto, BackupStatus } from "@shared/api/backups.ts";
import type { GameServerDto } from "@shared/api/servers.ts";
import { LIMITS } from "@shared/constants.ts";
import { BackupApi } from "@/Api/BackupApi.ts";
import { FileApi } from "@/Api/FileApi.ts";
import { formatAgo, formatBytes, formatDateTime } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import "./BackupList.scss";

export interface BackupListProps {
  server: GameServerDto;
}

const RESTORABLE_STATES = ["stopped", "crashed", "install_failed"];

const STATUS_BADGES: Record<BackupStatus, { tone: "neutral" | "info" | "ok" | "bad"; label: string }> = {
  pending: { tone: "neutral", label: "Pending" },
  running: { tone: "info", label: "Running" },
  done: { tone: "ok", label: "Done" },
  failed: { tone: "bad", label: "Failed" },
};

/**
 * The Backups tab (M4): `BackupApi.useBackups` list (name, status badge, size, created by, when), "Back up now"
 * (optional name; disabled while an operation runs or at the limit, showing `limit.used`/`limit.max`), live progress
 * of the running backup or restore (`BackupApi.useProgress`, `Progress` with bytes/totalBytes), download, delete
 * (AlertDialog), restore (AlertDialog that says the current files are replaced; enabled only while the server is
 * stopped, crashed or install_failed).
 */
export default function BackupList(props: BackupListProps) {
  const { server } = props;
  const notify = useNotify();
  const backups = BackupApi.useBackups(server.id);
  const progress = BackupApi.useProgress(server.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<BackupDto | null>(null);
  const [restoring, setRestoring] = useState<BackupDto | null>(null);

  const data = backups.data;
  const operation: BackupOperationDto | null = data?.operation ?? null;
  // The list says whether an operation runs (it is refetched on every `backup.updated`); a progress event only refines
  // its numbers, so one that lands just after the operation finished can't leave a stale bar.
  const live = operation
    ? (progress && progress.backupId === operation.backupId ? progress : { operation: operation.operation, backupId: operation.backupId, bytes: operation.bytes, totalBytes: operation.totalBytes })
    : null;
  const busy = live !== null;
  const limit = data?.limit;
  const atLimit = limit !== undefined && limit.max !== null && limit.used >= limit.max;
  const offline = !server.host.online;
  const canRestoreState = RESTORABLE_STATES.includes(server.state);

  const download = async (backup: BackupDto) => {
    try {
      FileApi.startDownload(await BackupApi.downloadTicket(server.id, backup.id));
    } catch (error) {
      notify.error(error, `Couldn't download ${backup.name}`);
    }
  };

  const remove = async (backup: BackupDto) => {
    try {
      await BackupApi.remove(server.id, backup.id);
      await backups.reload();
      notify.ok(`${backup.name} deleted`);
    } catch (error) {
      notify.error(error, `Couldn't delete ${backup.name}`);
    }
  };

  const restore = async (backup: BackupDto) => {
    try {
      await BackupApi.restore(server.id, backup.id);
      await backups.reload();
      notify.ok("Restore started", `${backup.name} is replacing the server's data.`);
    } catch (error) {
      notify.error(error, `Couldn't restore ${backup.name}`);
    }
  };

  let hint: string | null = null;
  if (offline) hint = `${server.host.name} is offline, so backups can't be created or restored right now.`;
  else if (atLimit && limit?.max != null) hint = `The limit of ${limit.max} backups is reached. Delete an old backup to make a new one.`;

  return (
    <Card className="backup-list">
      <CardHeader
        title="Backups"
        description={limit ? `${limit.max === null ? `${limit.used} ${limit.used === 1 ? "backup" : "backups"}` : `${limit.used} of ${limit.max} backups used`}. Archives are stored on ${server.host.name}.` : "Archives of the server's data, stored on its host."}
        actions={<Button size="sm" variant="primary" icon={Plus} disabled={offline || busy || atLimit || data === null} onClick={() => setCreateOpen(true)}>Back up now</Button>}
      />
      <CardBody>
        <Stack gap="12">
          {live && (
            <div className="backup-list__progress" role="status">
              <Progress
                label={live.operation === "restore" ? "Restoring a backup" : "Creating a backup"}
                value={live.totalBytes ? Math.min(live.bytes, live.totalBytes) : null}
                max={live.totalBytes ?? 100}
                showValue={live.totalBytes !== null}
                format={(value, max) => `${formatBytes(value)} of ${formatBytes(max)}`}
              />
              {live.totalBytes === null && <span className="io-text-muted">{formatBytes(live.bytes)} processed so far</span>}
            </div>
          )}
          {hint && <span className="io-text-muted">{hint}</span>}
          {!canRestoreState && !offline && data && data.backups.some((backup) => backup.status === "done") && (
            <span className="io-text-muted">Restoring needs the server stopped. Stop it first.</span>
          )}

          {backups.error && data === null
            ? <LoadError title="Couldn't load the backups" error={backups.error} onRetry={() => backups.reload()} />
            : data === null
            ? <div className="backup-list__loading" role="status"><Spinner /> Loading…</div>
            : (
              <>
                {backups.error && <LoadError title="Couldn't refresh the backups" error={backups.error} onRetry={() => backups.reload()} />}
                {data.backups.length === 0
                  ? <EmptyState size="sm" icon={Archive} title="No backups yet" description="A backup saves the server's data folder and its services. Make one before risky changes." />
                  : (
                    <Table plain density="compact" aria-label="Backups">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead numeric>Size</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead className="backup-list__actions"><span className="io-visually-hidden">Actions</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.backups.map((backup) => {
                          const badge = STATUS_BADGES[backup.status];
                          const active = backup.status === "pending" || backup.status === "running";
                          return (
                            <TableRow key={backup.id}>
                              <TableCell>
                                <span className="backup-list__name">{backup.name}</span>
                                {backup.status === "failed" && backup.error && <span className="backup-list__error">{backup.error}</span>}
                              </TableCell>
                              <TableCell><Badge size="sm" tone={badge.tone}>{badge.label}</Badge></TableCell>
                              <TableCell numeric>{backup.sizeBytes !== null ? formatBytes(backup.sizeBytes) : ""}</TableCell>
                              <TableCell>
                                <span title={formatDateTime(backup.createdAt)}>{formatAgo(backup.createdAt)}</span>
                                <span className="backup-list__by">{backup.createdBy ? backup.createdBy.username : "Schedule"}</span>
                              </TableCell>
                              <TableCell className="backup-list__actions">
                                <Menu.Root>
                                  <Menu.Trigger variant="ghost" size="sm" iconOnly icon={Ellipsis} aria-label={`Actions for ${backup.name}`} />
                                  <Menu.Content align="end">
                                    <Menu.Item icon={ArchiveRestore} disabled={backup.status !== "done" || busy || offline || !canRestoreState} onClick={() => setRestoring(backup)}>Restore</Menu.Item>
                                    <Menu.Item icon={Download} disabled={backup.status !== "done" || offline} onClick={() => download(backup)}>Download</Menu.Item>
                                    <Menu.Separator />
                                    <Menu.Item icon={Trash2} tone="bad" disabled={active} onClick={() => setDeleting(backup)}>Delete</Menu.Item>
                                  </Menu.Content>
                                </Menu.Root>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
              </>
            )}
        </Stack>
      </CardBody>

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (name) => {
          await BackupApi.create(server.id, name ? { name } : {});
          await backups.reload();
          notify.ok("Backup started");
        }}
      />

      <AlertDialog.Root open={deleting !== null} onOpenChange={(isOpen) => !isOpen && setDeleting(null)}>
        <AlertDialog.Content title={`Delete ${deleting?.name ?? "this backup"}?`} description="The archive is removed from the host. This can't be undone.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => deleting && remove(deleting)}>Delete backup</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <AlertDialog.Root open={restoring !== null} onOpenChange={(isOpen) => !isOpen && setRestoring(null)}>
        <AlertDialog.Content
          title={`Restore ${restoring?.name ?? "this backup"}?`}
          description="The server's current data, including its services' data, is replaced by this backup. Anything saved since then is lost. The server must be stopped, and it stays stopped afterwards."
        >
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => restoring && restore(restoring)}>Replace data and restore</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}

function CreateDialog(props: { open: boolean; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const { open, onClose, onCreate } = props;
  const notify = useNotify();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate(name.trim());
      setName("");
      onClose();
    } catch (error) {
      notify.error(error, "Couldn't start the backup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !busy && onClose()}>
      <Dialog.Content title="Back up now" description="Saves the data folder and the data of its services. A running game keeps running.">
        <form onSubmit={submit}>
          <Dialog.Body>
            <Input label="Name" description="Optional. Default: Backup and the date." autoFocus maxLength={LIMITS.BACKUP_NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} />
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy}>Create backup</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
