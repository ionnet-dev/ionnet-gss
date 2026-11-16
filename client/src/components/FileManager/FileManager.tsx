import { type ChangeEvent, type DragEvent, Fragment, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
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
import { ChevronRight, Download, Ellipsis, File, Folder, FolderOpen, FolderPlus, House, Link, Pencil, RefreshCw, Trash2, Upload, X } from "@ionnet/iontronic/icons";
import type { FileEntryDto } from "@shared/api/files.ts";
import type { GameServerDto } from "@shared/api/servers.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { FileApi } from "@/Api/FileApi.ts";
import { formatBytes, formatDateTime } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import FileEditor from "./FileEditor.tsx";
import "./FileManager.scss";

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

  if (!server.host.online) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={FolderOpen} tone="warn" title="The host is offline" description={`${server.host.name} isn't connected, so the files of ${server.name} can't be reached. They are listed again once the host is back.`} />
        </CardBody>
      </Card>
    );
  }
  if (server.state === "creating" || server.state === "deleting") {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={FolderOpen} title="No files yet" description={server.state === "creating" ? "The server is being created. Its files can be managed once that has finished." : "The server is being deleted."} />
        </CardBody>
      </Card>
    );
  }
  return <FileBrowser server={server} />;
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function typeLabel(entry: FileEntryDto): string {
  if (entry.type === "dir") return "Folder";
  if (entry.type === "symlink") return "Symlink";
  if (entry.type === "file") return "File";
  return "Other";
}

type UploadState = "queued" | "uploading" | "done" | "failed" | "cancelled" | "skipped";

interface UploadItem {
  id: number;
  name: string;
  sent: number;
  total: number;
  state: UploadState;
  error: string | null;
}

interface QueuedUpload {
  id: number;
  file: File;
  folder: string;
  controller: AbortController;
}

interface OverwriteQuestion {
  name: string;
  message: string;
}

function FileBrowser(props: { server: GameServerDto }) {
  const { server } = props;
  const notify = useNotify();
  const [path, setPath] = useState("");
  const files = FileApi.useFiles(server.id, path);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<FileEntryDto | null>(null);
  const [renaming, setRenaming] = useState<FileEntryDto | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [deleting, setDeleting] = useState<FileEntryDto[] | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [question, setQuestion] = useState<OverwriteQuestion | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const entries = files.data?.entries ?? [];
  const selected = entries.filter((entry) => selection.has(entry.path));

  const navigate = (next: string) => {
    setSelection(new Set());
    setPath(next);
  };

  const reloadRef = useRef(files.reload);
  reloadRef.current = files.reload;
  const pathRef = useRef(path);
  pathRef.current = path;

  const toggle = (entry: FileEntryDto, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(entry.path);
      else next.delete(entry.path);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => setSelection(checked ? new Set(entries.map((entry) => entry.path)) : new Set());

  const open = async (entry: FileEntryDto) => {
    if (entry.type === "dir") navigate(entry.path);
    else if (entry.type === "file") setEditing(entry);
    else if (entry.type === "symlink") {
      // A link may point at a folder or a file; the agent knows which.
      try {
        await FileApi.list(server.id, entry.path);
        navigate(entry.path);
      } catch {
        setEditing(entry);
      }
    }
  };

  const download = async (entry: FileEntryDto) => {
    try {
      FileApi.startDownload(await FileApi.downloadTicket(server.id, entry.path));
    } catch (error) {
      notify.error(error, `Couldn't download ${entry.name}`);
    }
  };

  const remove = async (targets: FileEntryDto[]) => {
    try {
      await FileApi.remove(server.id, targets.map((entry) => entry.path));
      setSelection(new Set());
      await files.reload();
      notify.ok(targets.length === 1 ? `${targets[0].name} deleted` : `${targets.length} items deleted`);
    } catch (error) {
      notify.error(error, "Couldn't delete");
      await files.reload();
    }
  };

  //#region Uploads
  const queue = useRef<QueuedUpload[]>([]);
  const controllers = useRef(new Map<number, AbortController>());
  const running = useRef(false);
  const nextId = useRef(1);
  const answer = useRef<((overwrite: boolean) => void) | null>(null);

  const patchUpload = useCallback((id: number, patch: Partial<UploadItem>) => {
    setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const ask = (name: string, message: string) =>
    new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setQuestion({ name, message });
    });

  const reply = (overwrite: boolean) => {
    answer.current?.(overwrite);
    answer.current = null;
    setQuestion(null);
  };

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        const { id, file, folder, controller } = next;
        if (controller.signal.aborted) continue;
        const target = joinPath(folder, file.name);
        patchUpload(id, { state: "uploading" });
        let overwrite = false;
        for (;;) {
          try {
            await FileApi.upload(server.id, target, file, overwrite, (sent, total) => patchUpload(id, { sent, total }), controller.signal);
            patchUpload(id, { state: "done", sent: file.size, total: file.size });
            if (folder === pathRef.current) await reloadRef.current();
            break;
          } catch (error) {
            if (controller.signal.aborted) {
              patchUpload(id, { state: "cancelled" });
              break;
            }
            // Only "already exists" can be answered by overwriting; other 409s (restore running, folder in the way) just fail.
            if (!overwrite && error instanceof ApiError && error.status === 409 && /already exists/i.test(error.message)) {
              if (await ask(file.name, error.message)) {
                overwrite = true;
                continue;
              }
              patchUpload(id, { state: "skipped" });
              break;
            }
            patchUpload(id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        controllers.current.delete(id);
      }
    } finally {
      running.current = false;
    }
  }, [server.id, patchUpload]);

  const enqueue = (list: File[]) => {
    if (list.length === 0) return;
    const items: UploadItem[] = [];
    for (const file of list) {
      const id = nextId.current++;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      queue.current.push({ id, file, folder: path, controller });
      items.push({ id, name: file.name, sent: 0, total: file.size, state: "queued", error: null });
    }
    setUploads((current) => [...current, ...items]);
    drain();
  };

  const cancelUpload = (item: UploadItem) => {
    controllers.current.get(item.id)?.abort();
    if (item.state === "queued") patchUpload(item.id, { state: "cancelled" });
  };

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      answer.current?.(false);
    };
  }, []);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    enqueue(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (hasFiles(event)) event.preventDefault();
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    enqueue(Array.from(event.dataTransfer.files));
  };
  //#endregion

  const segments = path ? path.split("/") : [];
  const allSelected = entries.length > 0 && selected.length === entries.length;
  const hasUploads = uploads.length > 0;
  const finished = uploads.filter((item) => item.state !== "queued" && item.state !== "uploading");

  return (
    <Card className="file-manager" data-dragging={dragging ? "" : undefined} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <CardHeader
        title="Files"
        description="The server's data folder. Changes to a running game's files apply when it reloads them."
        actions={
          <Stack direction="row" gap="8" wrap>
            <Button size="sm" icon={FolderPlus} onClick={() => setNewFolderOpen(true)}>New folder</Button>
            <Button size="sm" variant="primary" icon={Upload} onClick={() => fileInput.current?.click()}>Upload</Button>
            <Button size="sm" variant="ghost" iconOnly icon={RefreshCw} aria-label="Refresh" loading={files.loading} onClick={() => files.reload()} />
            <input ref={fileInput} className="file-manager__input" type="file" multiple onChange={onPick} aria-label="Choose files to upload" />
          </Stack>
        }
      />
      <CardBody>
        <Stack gap="12">
          <nav className="file-manager__crumbs" aria-label="Current folder">
            <button type="button" className="file-manager__crumb" aria-current={path === "" ? "page" : undefined} onClick={() => navigate("")}>
              <Icon icon={House} size="sm" /> data
            </button>
            {segments.map((segment, index) => {
              const target = segments.slice(0, index + 1).join("/");
              const last = index === segments.length - 1;
              return (
                <Fragment key={target}>
                  <Icon icon={ChevronRight} size="sm" className="file-manager__sep" />
                  <button type="button" className="file-manager__crumb" aria-current={last ? "page" : undefined} onClick={() => navigate(target)}>{segment}</button>
                </Fragment>
              );
            })}
          </nav>

          {selected.length > 0 && (
            <div className="file-manager__selection" role="status">
              <span>{selected.length} selected</span>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting(selected)}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>Clear</Button>
            </div>
          )}

          {hasUploads && (
            <div className="file-manager__uploads" aria-label="Uploads">
              {uploads.map((item) => <UploadRow key={item.id} item={item} onCancel={() => cancelUpload(item)} />)}
              {finished.length === uploads.length && (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setUploads([])}>Clear list</Button>
                </div>
              )}
            </div>
          )}

          {files.error && files.data === null
            ? <LoadError title="Couldn't list this folder" error={files.error} onRetry={() => files.reload()} />
            : files.loading && files.data === null
            ? <div className="file-manager__loading" role="status"><Spinner /> Loading…</div>
            : (
              <>
                {files.error && <LoadError title="Couldn't refresh this folder" error={files.error} onRetry={() => files.reload()} />}
                {entries.length === 0
                  ? <EmptyState size="sm" icon={Folder} title="This folder is empty" description="Drop files here or use Upload to add some." />
                  : (
                    <Table plain interactive density="compact" aria-label={`Files in ${path || "the data folder"}`}>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="file-manager__check">
                            <Checkbox aria-label="Select all" checked={allSelected} indeterminate={selected.length > 0 && !allSelected} onCheckedChange={toggleAll} />
                          </TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead numeric>Size</TableHead>
                          <TableHead>Modified</TableHead>
                          <TableHead className="file-manager__actions"><span className="io-visually-hidden">Actions</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entries.map((entry) => (
                          <TableRow key={entry.path} selected={selection.has(entry.path)}>
                            <TableCell className="file-manager__check">
                              <Checkbox aria-label={`Select ${entry.name}`} checked={selection.has(entry.path)} onCheckedChange={(checked) => toggle(entry, checked)} />
                            </TableCell>
                            <TableCell>
                              <button type="button" className="file-manager__name" data-type={entry.type} disabled={entry.type === "other"} onClick={() => open(entry)}>
                                <Icon icon={entry.type === "dir" ? Folder : entry.type === "symlink" ? Link : File} size="sm" />
                                <span>{entry.name}</span>
                              </button>
                              {entry.type === "symlink" && entry.linkTarget && <span className="file-manager__target">→ {entry.linkTarget}</span>}
                            </TableCell>
                            <TableCell>{entry.type === "symlink" ? <Badge size="sm" tone="info">Symlink</Badge> : typeLabel(entry)}</TableCell>
                            <TableCell numeric>{entry.type === "dir" ? "" : formatBytes(entry.size)}</TableCell>
                            <TableCell>{formatDateTime(entry.modifiedAt)}</TableCell>
                            <TableCell className="file-manager__actions">
                              <Menu.Root>
                                <Menu.Trigger variant="ghost" size="sm" iconOnly icon={Ellipsis} aria-label={`Actions for ${entry.name}`} />
                                <Menu.Content align="end">
                                  {entry.type !== "other" && <Menu.Item icon={entry.type === "file" ? Pencil : FolderOpen} onClick={() => open(entry)}>{entry.type === "file" ? "Edit" : "Open"}</Menu.Item>}
                                  {(entry.type === "file" || entry.type === "symlink") && <Menu.Item icon={Download} onClick={() => download(entry)}>Download</Menu.Item>}
                                  <Menu.Item icon={Pencil} onClick={() => setRenaming(entry)}>Rename or move</Menu.Item>
                                  <Menu.Separator />
                                  <Menu.Item icon={Trash2} tone="bad" onClick={() => setDeleting([entry])}>Delete</Menu.Item>
                                </Menu.Content>
                              </Menu.Root>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                {files.data?.truncated && <span className="io-text-muted">This folder has more entries than can be listed; only the first ones are shown.</span>}
              </>
            )}
        </Stack>
      </CardBody>

      {dragging && <div className="file-manager__drop" aria-hidden="true">Drop to upload to {path ? `/${path}` : "the data folder"}</div>}

      {editing && (
        <FileEditor
          serverId={server.id}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            files.reload();
          }}
        />
      )}

      <PathDialog
        open={newFolderOpen}
        title="New folder"
        description={`Created in ${path ? `/${path}` : "the data folder"}.`}
        label="Folder name"
        initial=""
        submitLabel="Create folder"
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          await FileApi.createFolder(server.id, joinPath(path, name));
          await files.reload();
          notify.ok(`${name} created`);
        }}
      />

      <PathDialog
        key={renaming?.path ?? "none"}
        open={renaming !== null}
        title={`Rename ${renaming?.name ?? ""}`}
        description="Give a new name, or a different folder to move it. Paths are relative to the data folder."
        label="New path"
        initial={renaming?.path ?? ""}
        submitLabel="Rename"
        allowOverwrite={renaming?.type === "file"}
        onClose={() => setRenaming(null)}
        onSubmit={async (to, overwrite) => {
          if (!renaming) return;
          await FileApi.rename(server.id, renaming.path, to, overwrite);
          await files.reload();
          notify.ok(`${renaming.name} renamed`);
        }}
      />

      <AlertDialog.Root open={deleting !== null} onOpenChange={(isOpen) => !isOpen && setDeleting(null)}>
        <AlertDialog.Content
          title={deleting && deleting.length === 1 ? `Delete ${deleting[0].name}?` : `Delete ${deleting?.length ?? 0} items?`}
          description={deleting?.some((entry) => entry.type === "dir") ? "Folders are deleted with everything inside them. This can't be undone." : "This can't be undone."}
        >
          <AlertDialog.Body>
            <ul className="file-manager__names">
              {(deleting ?? []).slice(0, 8).map((entry) => <li key={entry.path}>{entry.name}{entry.type === "dir" ? "/" : ""}</li>)}
              {(deleting?.length ?? 0) > 8 && <li>and {(deleting?.length ?? 0) - 8} more</li>}
            </ul>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => deleting && remove(deleting)}>Delete</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <AlertDialog.Root open={question !== null} onOpenChange={(isOpen) => !isOpen && reply(false)}>
        <AlertDialog.Content title={`Overwrite ${question?.name ?? "the file"}?`} description={`${question?.message ?? ""} Uploading it again replaces the existing file.`}>
          <AlertDialog.Footer>
            <AlertDialog.Close onClick={() => reply(false)}>Skip this file</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => reply(true)}>Overwrite</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}

const UPLOAD_LABELS: Record<UploadState, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

function UploadRow(props: { item: UploadItem; onCancel: () => void }) {
  const { item, onCancel } = props;
  const active = item.state === "queued" || item.state === "uploading";
  return (
    <div className="file-manager__upload" data-state={item.state}>
      <div className="file-manager__upload-head">
        <span className="file-manager__upload-name">{item.name}</span>
        <span className="io-text-muted">
          {item.state === "uploading" ? `${formatBytes(item.sent)} of ${formatBytes(item.total)}` : formatBytes(item.total)} · {UPLOAD_LABELS[item.state]}
        </span>
        {active && <Button size="sm" variant="ghost" iconOnly icon={X} aria-label={`Cancel upload of ${item.name}`} onClick={onCancel} />}
      </div>
      {item.state === "uploading" && <Progress size="sm" value={item.total > 0 ? item.sent : null} max={Math.max(item.total, 1)} aria-label={`Uploading ${item.name}`} />}
      {item.state === "failed" && item.error && <span className="file-manager__upload-error" role="alert">{item.error}</span>}
    </div>
  );
}

interface PathDialogProps {
  open: boolean;
  title: string;
  description: string;
  label: string;
  initial: string;
  submitLabel: string;
  /**
   * A 409 (the target exists) offers "Replace" instead of just failing.
   */
  allowOverwrite?: boolean;
  onClose: () => void;
  onSubmit: (value: string, overwrite: boolean) => Promise<void>;
}

/**
 * One text field in a dialog: the new folder's name or a file's new path. Errors stay in the dialog.
 */
function PathDialog(props: PathDialogProps) {
  const { open, title, description, label, initial, submitLabel, allowOverwrite = false, onClose, onSubmit } = props;
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(initial);
    setError(null);
    setExists(false);
  }, [open, initial]);

  const submit = async (overwrite: boolean) => {
    const trimmed = value.trim().replace(/^\/+/, "");
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, overwrite);
      onClose();
    } catch (err) {
      setExists(err instanceof ApiError && err.status === 409 && /already exists/i.test(err.message));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !busy && onClose()}>
      <Dialog.Content title={title} description={description}>
        <form onSubmit={onFormSubmit}>
          <Dialog.Body>
            <Input label={label} autoFocus value={value} error={error} onChange={(event) => setValue(event.target.value)} />
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            {exists && allowOverwrite && <Button variant="danger" loading={busy} onClick={() => submit(true)}>Replace existing file</Button>}
            <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
