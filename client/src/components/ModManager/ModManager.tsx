import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { AlertDialog, Avatar, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Icon, IconTile, Input, Progress, Spinner, Stack, Switch } from "@ionnet/iontronic/react";
import { File, FolderArchive, Folder, Puzzle, RefreshCw, RotateCw, Search, Trash2, Upload, X } from "@ionnet/iontronic/icons";
import type { ModDto, ModFolderDto, ModPackPreviewDto, ModsResponse } from "@shared/api/mods.ts";
import type { GameServerDetailResponse } from "@shared/api/servers.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { ModApi } from "@/Api/ModApi.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import { formatBytes } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import ModBrowser from "./ModBrowser.tsx";
import ModPackDialog from "./ModPackDialog.tsx";
import { describePatterns, describeInstall, filePatterns, isPackFile, matchesFile, providerLabel } from "./modFiles.ts";
import { type UploadItem, type UploadState, useModUploads } from "./useModUploads.ts";
import "./ModManager.scss";

export interface ModManagerProps {
  server: GameServerDetailResponse;
}

const FILTER_FROM = 8; // Folders with more mods than this get a filter input.

/**
 * The Mods tab: one card per mod folder of the game's definition. Drop or pick files to upload them (checked against
 * the folder's file patterns), switch a mod off to move it out of the folder, delete, and install or update from the
 * folder's catalog. Changes apply the next time the server starts.
 */
export default function ModManager(props: ModManagerProps) {
  const { server } = props;
  if (!server.host.online) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={Puzzle} tone="warn" title="The host is offline" description={`${server.host.name} isn't connected, so the mods of ${server.name} can't be reached. They are listed again once the host is back.`} />
        </CardBody>
      </Card>
    );
  }
  if (server.state === "creating" || server.state === "deleting") {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={Puzzle} title="No mods yet" description={server.state === "creating" ? "The server is being created. Its mods can be managed once that has finished." : "The server is being deleted."} />
        </CardBody>
      </Card>
    );
  }
  return <Folders server={server} />;
}

function Folders(props: ModManagerProps) {
  const { server } = props;
  const resource = ModApi.useMods(server.id);
  if (resource.error && !resource.data) return <LoadError title="Couldn't load the mods" error={resource.error} onRetry={resource.reload} />;
  if (!resource.data) {
    return (
      <Stack direction="row" gap="8" align="center" role="status">
        <Spinner />
        <span className="io-text-muted">Reading the mod folders…</span>
      </Stack>
    );
  }
  const data: ModsResponse = resource.data;
  return (
    <Stack gap="16">
      {resource.error && <LoadError title="Couldn't refresh the mods" error={resource.error} onRetry={resource.reload} />}
      {data.folders.map((folder) => (
        <FolderCard key={folder.key} server={server} folder={folder} version={data.version} loading={resource.loading} reload={resource.reload} />
      ))}
    </Stack>
  );
}

type Busy = "state" | "delete" | "update" | "restart";

interface FolderCardProps {
  server: GameServerDetailResponse;
  folder: ModFolderDto;
  version: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

function FolderCard(props: FolderCardProps) {
  const { server, folder, version, loading, reload } = props;
  const notify = useNotify();
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<Busy | null>(null);
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<ModDto[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [changed, setChanged] = useState(false);
  const [packUpload, setPackUpload] = useState<UploadItem | null>(null);
  const [preview, setPreview] = useState<ModPackPreviewDto | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const packInput = useRef<HTMLInputElement>(null);
  const packController = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);

  const { uploads, question, enqueue, cancel, clear, reply } = useModUploads(server.id, folder.key, () => {
    setChanged(true);
    return reload();
  });

  const needle = filter.trim().toLowerCase();
  const shown = folder.mods.filter((mod) => needle === "" || `${mod.name} ${mod.info?.title ?? ""}`.toLowerCase().includes(needle));
  const selected = folder.mods.filter((mod) => selection.has(mod.name));
  const updatable = folder.mods.filter((mod) => mod.update);
  const canRestart = server.state === "running" && server.host.online;
  const disabled = busy !== null;
  const patterns = filePatterns(folder.match);

  const perform = async (kind: Busy, work: () => Promise<void>, failure: string) => {
    setBusy(kind);
    try {
      await work();
      setChanged(true);
    } catch (error) {
      notify.error(error, failure);
    }
    finally {
      await reload();
      setBusy(null);
    }
  };

  const setEnabled = (mods: ModDto[], enabled: boolean) => {
    const names = mods.filter((mod) => mod.enabled !== enabled).map((mod) => mod.name);
    if (names.length === 0) return Promise.resolve();
    return perform("state", async () => {
      await ModApi.setState(server.id, folder.key, names, enabled);
      notify.ok(names.length === 1 ? `${names[0]} ${enabled ? "enabled" : "disabled"}` : `${names.length} mods ${enabled ? "enabled" : "disabled"}`);
    }, enabled ? "Couldn't enable" : "Couldn't disable");
  };

  const remove = (mods: ModDto[]) => perform("delete", async () => {
    await ModApi.remove(server.id, folder.key, mods.map((mod) => mod.name));
    setSelection(new Set());
    notify.ok(mods.length === 1 ? `${mods[0].name} deleted` : `${mods.length} mods deleted`);
  }, "Couldn't delete");

  const update = (mods: ModDto[]) => perform("update", async () => {
    const response = await ModApi.update(server.id, folder.key, mods.map((mod) => mod.name));
    notify.ok(response.installed.length > 0 ? "Updated" : "Nothing updated", describeInstall(response));
  }, "Couldn't update");

  const restart = async () => {
    setBusy("restart");
    try {
      await ServerApi.restart(server.id);
      setChanged(false);
      notify.ok("The server is restarting", "The mod changes apply once it is up.");
    } catch (error) {
      notify.error(error, "Couldn't restart the server");
    }
    finally {
      setBusy(null);
    }
  };

  useEffect(() => () => packController.current?.abort(), []);

  const importPack = async (file: File) => {
    const controller = new AbortController();
    packController.current = controller;
    const item: UploadItem = { id: 0, name: file.name, sent: 0, total: file.size, state: "uploading", error: null };
    setPackUpload(item);
    try {
      const result = await ModApi.uploadPack(server.id, folder.key, file, {
        onProgress: (sent, total) => setPackUpload((current) => (current ? { ...current, sent, total } : current)),
        signal: controller.signal,
      });
      setPackUpload(null);
      setPreview(result);
    } catch (error) {
      if (controller.signal.aborted) setPackUpload(null);
      else setPackUpload({ ...item, state: "failed", error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error) });
    }
  };

  //#region Dropped and picked files
  const accept = (files: File[], folders: string[]) => {
    const problems: string[] = [];
    const allowed: File[] = [];
    let pack: File | null = null;
    for (const file of files) {
      if (matchesFile(file.name, folder.match)) allowed.push(file);
      else if (isPackFile(file.name, folder)) {
        if (pack === null && packUpload?.state !== "uploading") pack = file;
        else problems.push(`${file.name}: import one modpack at a time.`);
      }
      else problems.push(`${file.name} doesn't match ${folder.match.join(", ")}${folder.packs.length > 0 ? " and isn't a modpack (.mrpack, .zip or manifest.json)" : ""}.`);
    }
    if (pack) importPack(pack);
    for (const name of folders) problems.push(`${name} is a folder; folders can't be uploaded by drop yet. Put it in through the Files tab or SFTP.`);
    setRefused(problems);
    enqueue(allowed);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    accept(Array.from(event.target.files ?? []), []);
    event.target.value = "";
  };

  const onPickPack = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRefused([]);
    importPack(file);
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
    const files: File[] = [];
    const folders: string[] = [];
    const items = Array.from(event.dataTransfer.items ?? []);
    if (items.length > 0) {
      // The entries are only readable during the event.
      for (const item of items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) folders.push(entry.name);
        else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    else files.push(...Array.from(event.dataTransfer.files));
    accept(files, folders);
  };
  //#endregion

  const toggle = (mod: ModDto, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(mod.name);
      else next.delete(mod.name);
      return next;
    });
  };
  const allShownSelected = shown.length > 0 && shown.every((mod) => selection.has(mod.name));
  const toggleAll = (checked: boolean) => setSelection(checked ? new Set(shown.map((mod) => mod.name)) : new Set());
  const finished = uploads.every((item) => item.state !== "queued" && item.state !== "uploading");

  return (
    <Card className="mod-manager" data-dragging={dragging ? "" : undefined} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <CardHeader
        title={folder.label}
        description={
          <>
            {folder.description && <span className="mod-manager__line">{folder.description}</span>}
            <span className="mod-manager__line">
              <span className="io-mono">{folder.folder}/</span> · Disabled mods wait in <span className="io-mono">{folder.disabledFolder}/</span>. Changes apply the next time the server starts.
            </span>
          </>
        }
        actions={
          <Stack direction="row" gap="8" wrap>
            <Button size="sm" variant="primary" icon={Upload} disabled={disabled} onClick={() => fileInput.current?.click()}>Upload</Button>
            {folder.packs.length > 0 && <Button size="sm" icon={FolderArchive} disabled={disabled || packUpload?.state === "uploading"} onClick={() => packInput.current?.click()}>Import modpack</Button>}
            {folder.catalogs.length > 0 && <Button size="sm" icon={Search} disabled={disabled} onClick={() => setBrowsing(true)}>Browse {folder.catalogs.length === 1 ? folder.catalogs[0].label : "catalogs"}</Button>}
            {canRestart && <Button size="sm" variant={changed ? "primary" : "secondary"} icon={RotateCw} loading={busy === "restart"} disabled={disabled} onClick={restart}>Restart</Button>}
            <Button size="sm" variant="ghost" iconOnly icon={RefreshCw} aria-label={`Refresh ${folder.label}`} loading={loading} onClick={() => reload()} />
            <input ref={fileInput} className="mod-manager__input" type="file" multiple onChange={onPick} aria-label={`Choose files to upload to ${folder.label}`} />
            <input ref={packInput} className="mod-manager__input" type="file" accept=".mrpack,.zip,.json" onChange={onPickPack} aria-label={`Choose a modpack to import into ${folder.label}`} />
          </Stack>
        }
      />
      <CardBody>
        <Stack gap="12">
          {refused.length > 0 && (
            <div className="mod-manager__refused" role="alert">
              <div className="mod-manager__refused-head">
                <strong>{refused.length === 1 ? "A file was refused" : `${refused.length} files were refused`}</strong>
                <Button size="sm" variant="ghost" iconOnly icon={X} aria-label="Dismiss" onClick={() => setRefused([])} />
              </div>
              <ul>{refused.map((message) => <li key={message}>{message}</li>)}</ul>
            </div>
          )}

          {packUpload && (
            <div className="mod-manager__uploads" aria-label="Modpack import">
              <UploadRow item={packUpload} onCancel={() => packController.current?.abort()} />
              {packUpload.state === "failed" && <div><Button size="sm" variant="ghost" onClick={() => setPackUpload(null)}>Dismiss</Button></div>}
            </div>
          )}

          {uploads.length > 0 && (
            <div className="mod-manager__uploads" aria-label="Uploads">
              {uploads.map((item) => <UploadRow key={item.id} item={item} onCancel={() => cancel(item)} />)}
              {finished && <div><Button size="sm" variant="ghost" onClick={clear}>Clear list</Button></div>}
            </div>
          )}

          {folder.updatesError && <span className="mod-manager__warning" role="status">Couldn't check for updates: {folder.updatesError}</span>}

          {folder.mods.length === 0
            ? (
              <button type="button" className="mod-manager__empty" onClick={() => fileInput.current?.click()}>
                <Icon icon={Upload} size="lg" />
                <strong>Drop {describePatterns(folder.match)} here</strong>
                <span className="io-text-muted">
                  or click to choose {patterns.length > 0 ? "them" : "files"}{folder.packs.length > 0 ? ", or import a modpack" : ""}{folder.catalogs.length > 0 ? `, or browse ${folder.catalogs.map((catalog) => catalog.label).join(" or ")} above` : ""}.
                </span>
              </button>
            )
            : (
              <>
                <div className="mod-manager__toolbar">
                  <Checkbox aria-label="Select all" checked={allShownSelected} indeterminate={selected.length > 0 && !allShownSelected} onCheckedChange={toggleAll} />
                  {folder.mods.length > FILTER_FROM && (
                    <Input
                      className="mod-manager__filter"
                      aria-label={`Filter ${folder.label}`}
                      leading={<Icon icon={Search} />}
                      placeholder="Filter by name"
                      size="sm"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }}
                    />
                  )}
                  <Stack direction="row" gap="8" wrap align="center" className="mod-manager__bulk">
                    {selected.length > 0 && (
                      <>
                        <span className="io-text-muted" role="status">{selected.length} selected</span>
                        <Button size="sm" disabled={disabled} onClick={() => setEnabled(selected, true)}>Enable</Button>
                        <Button size="sm" disabled={disabled} onClick={() => setEnabled(selected, false)}>Disable</Button>
                        <Button size="sm" variant="danger" icon={Trash2} disabled={disabled} onClick={() => setDeleting(selected)}>Delete</Button>
                        <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>Clear</Button>
                      </>
                    )}
                    {updatable.length > 0 && <Button size="sm" variant="primary" loading={busy === "update"} disabled={disabled} onClick={() => update(updatable)}>Update all ({updatable.length})</Button>}
                  </Stack>
                </div>
                {shown.length === 0
                  ? <EmptyState size="sm" icon={Search} title="No mod matches" description="Try another name." />
                  : (
                    <div className="mod-manager__list" role="list">
                      {shown.map((mod) => (
                        <ModRow
                          key={`${mod.enabled}:${mod.name}`}
                          mod={mod}
                          selected={selection.has(mod.name)}
                          disabled={disabled}
                          updating={busy === "update"}
                          onSelect={(checked) => toggle(mod, checked)}
                          onToggle={(enabled) => setEnabled([mod], enabled)}
                          onUpdate={() => update([mod])}
                          onDelete={() => setDeleting([mod])}
                        />
                      ))}
                    </div>
                  )}
                {folder.mods.length >= 1 && <span className="io-text-muted mod-manager__hint">Drop {describePatterns(folder.match)} on this card to upload them.</span>}
              </>
            )}
        </Stack>
      </CardBody>

      {dragging && <div className="mod-manager__drop" aria-hidden="true">Drop to upload to {folder.folder}/</div>}

      {folder.catalogs.length > 0 && (
        <ModBrowser
          serverId={server.id}
          folder={folder}
          catalogs={folder.catalogs}
          version={version}
          open={browsing}
          onClose={() => setBrowsing(false)}
          onInstalled={() => {
            setChanged(true);
            reload();
          }}
        />
      )}

      <ModPackDialog
        key={preview?.token ?? "none"}
        serverId={server.id}
        folder={folder}
        preview={preview}
        onClose={() => setPreview(null)}
        onApplied={() => {
          setChanged(true);
          reload();
        }}
      />

      <DeleteDialog mods={deleting} all={folder.mods} onClose={() => setDeleting(null)} onConfirm={(mods) => remove(mods)} />

      <AlertDialog.Root open={question !== null} onOpenChange={(isOpen) => !isOpen && reply(false)}>
        <AlertDialog.Content title={`Replace ${question?.name ?? "the mod"}?`} description={`${question?.message ?? ""} Uploading it again replaces the existing file.`}>
          <AlertDialog.Footer>
            <AlertDialog.Close onClick={() => reply(false)}>Skip this file</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => reply(true)}>Replace</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}

interface ModRowProps {
  mod: ModDto;
  selected: boolean;
  disabled: boolean;
  updating: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: (enabled: boolean) => void;
  onUpdate: () => void;
  onDelete: () => void;
}

function ModRow(props: ModRowProps) {
  const { mod, selected, disabled, updating, onSelect, onToggle, onUpdate, onDelete } = props;
  const { info } = mod;
  const title = info?.title ?? mod.name;
  const label = info?.provider ? title : `${mod.name}${mod.isFolder ? "/" : ""}`; // No catalog behind it: the entry is its own name; show it once.
  return (
    <div className="mod-manager__row" role="listitem" data-enabled={mod.enabled ? "" : undefined} data-selected={selected ? "" : undefined}>
      <Checkbox aria-label={`Select ${title}`} checked={selected} onCheckedChange={onSelect} />
      <div className="mod-manager__icon">
        {info?.iconUrl
          ? <Avatar size="md" src={info.iconUrl} name={info.title} />
          : <IconTile size="sm" icon={mod.isFolder ? Folder : File} />}
      </div>
      <div className="mod-manager__main">
        <div className="mod-manager__title">
          <span className="mod-manager__name">{label}</span>
          {info?.versionNumber && <span className="io-text-muted">{info.versionNumber}</span>}
          {info?.provider && <Badge size="sm" tone="neutral" appearance="outline">{providerLabel(info.provider)}</Badge>}
          {!mod.enabled && <Badge size="sm" tone="neutral">Disabled</Badge>}
          {mod.update && <Badge size="sm" tone="info">Update available → {mod.update.versionNumber}</Badge>}
        </div>
        {info?.provider && <span className="mod-manager__entry io-mono io-text-muted">{mod.name}{mod.isFolder ? "/" : ""}</span>}
        {info && info.requiredBy.length > 0 && <span className="io-text-muted">Required by {info.requiredBy.join(", ")}</span>}
      </div>
      <span className="io-text-muted mod-manager__size">{mod.size !== null ? formatBytes(mod.size) : ""}</span>
      <div className="mod-manager__row-actions">
        {mod.update && <Button size="sm" loading={updating} disabled={disabled} onClick={onUpdate}>Update</Button>}
        <Switch size="sm" aria-label={`${mod.enabled ? "Disable" : "Enable"} ${title}`} checked={mod.enabled} disabled={disabled} onCheckedChange={onToggle} />
        <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label={`Delete ${title}`} disabled={disabled} onClick={onDelete} />
      </div>
    </div>
  );
}

interface DeleteDialogProps {
  mods: ModDto[] | null;
  all: ModDto[];
  onClose: () => void;
  onConfirm: (mods: ModDto[]) => void;
}

/**
 * Confirms deleting mods, naming them. Warns when a mod that stays installed lists a deleted one as a requirement.
 */
function DeleteDialog(props: DeleteDialogProps) {
  const { mods, all, onClose, onConfirm } = props;
  const targets = mods ?? [];
  const remaining = all.filter((mod) => !targets.some((target) => target.name === mod.name));
  const remainingTitles = new Set(remaining.map((mod) => mod.info?.title).filter((title): title is string => title !== undefined));
  const targetTitles = new Set(targets.map((mod) => mod.info?.title ?? mod.name));
  const warnings = targets.flatMap((mod) => {
    const needing = (mod.info?.requiredBy ?? []).filter((title) => remainingTitles.has(title));
    return needing.length > 0 ? [`${mod.info?.title ?? mod.name} is required by ${needing.join(", ")}, which may stop working without it.`] : [];
  });
  const orphans = remaining.filter((mod) => mod.info?.requiredBy.some((title) => targetTitles.has(title))).map((mod) => mod.info?.title ?? mod.name);
  return (
    <AlertDialog.Root open={mods !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AlertDialog.Content
        title={targets.length === 1 ? `Delete ${targets[0].info?.title ?? targets[0].name}?` : `Delete ${targets.length} mods?`}
        description={targets.some((mod) => mod.isFolder) ? "Folders are deleted with everything inside them. This can't be undone." : "The files are deleted from the server. This can't be undone."}
      >
        <AlertDialog.Body>
          <Stack gap="12">
            <ul className="mod-manager__names">
              {targets.slice(0, 8).map((mod) => <li key={mod.name}>{mod.name}{mod.isFolder ? "/" : ""}</li>)}
              {targets.length > 8 && <li>and {targets.length - 8} more</li>}
            </ul>
            {warnings.map((warning) => <span key={warning} className="mod-manager__warning" role="alert">{warning}</span>)}
            {orphans.length > 0 && <span className="io-text-muted">Installed as its dependency and kept: {orphans.join(", ")}.</span>}
          </Stack>
        </AlertDialog.Body>
        <AlertDialog.Footer>
          <AlertDialog.Close>Cancel</AlertDialog.Close>
          <AlertDialog.Close variant="danger" onClick={() => onConfirm(targets)}>Delete</AlertDialog.Close>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
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
    <div className="mod-manager__upload" data-state={item.state}>
      <div className="mod-manager__upload-head">
        <span className="mod-manager__upload-name">{item.name}</span>
        <span className="io-text-muted">
          {item.state === "uploading" ? `${formatBytes(item.sent)} of ${formatBytes(item.total)}` : formatBytes(item.total)} · {UPLOAD_LABELS[item.state]}
        </span>
        {active && <Button size="sm" variant="ghost" iconOnly icon={X} aria-label={`Cancel upload of ${item.name}`} onClick={onCancel} />}
      </div>
      {item.state === "uploading" && <Progress size="sm" value={item.total > 0 ? item.sent : null} max={Math.max(item.total, 1)} aria-label={`Uploading ${item.name}`} />}
      {item.state === "failed" && item.error && <span className="mod-manager__warning" role="alert">{item.error}</span>}
    </div>
  );
}
