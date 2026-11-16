import { useState } from "react";
import { Badge, Button, Checkbox, Dialog, Icon, Stack } from "@ionnet/iontronic/react";
import { ExternalLink, TriangleAlert } from "@ionnet/iontronic/icons";
import type { ModFolderDto, ModPackEntryDto, ModPackPreviewDto } from "@shared/api/mods.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { ModApi } from "@/Api/ModApi.ts";
import { formatBytes } from "@/components/Format/format.ts";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { describeInstall, providerLabel } from "./modFiles.ts";

export interface ModPackDialogProps {
  serverId: string;
  folder: ModFolderDto;
  /**
   * The previewed pack; null keeps the dialog closed. Give it a `key` of the token, so each pack starts from its own
   * default choices.
   */
  preview: ModPackPreviewDto | null;
  onClose: () => void;
  /**
   * The pack was applied: the folder's list is stale.
   */
  onApplied: () => void;
}

const FORMAT_LABELS = { mrpack: "Modrinth modpack", curseforge: "CurseForge pack", zip: "Zip of mod files" };

/**
 * The preview of an uploaded modpack: what it is made for, its warnings, a checklist of its mods and a summary of the
 * config files it would write. Apply installs the checked mods (and the config files when asked).
 */
export default function ModPackDialog(props: ModPackDialogProps) {
  const { preview, onClose } = props;
  return (
    <Dialog.Root open={preview !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      {preview && <PackContent {...props} preview={preview} />}
    </Dialog.Root>
  );
}

function initialChecks(preview: ModPackPreviewDto): Record<string, boolean> {
  return Object.fromEntries(preview.mods.map((mod) => [mod.key, mod.downloadable && mod.selected]));
}

function PackContent(props: ModPackDialogProps & { preview: ModPackPreviewDto }) {
  const { serverId, folder, preview, onClose, onApplied } = props;
  const notify = useNotify();
  const [checks, setChecks] = useState(() => initialChecks(preview));
  const [overrides, setOverrides] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installable = preview.mods.filter((mod) => mod.downloadable);
  const count = installable.filter((mod) => checks[mod.key]).length;
  const writesFiles = preview.overrides.count > 0;

  const setAll = (checked: boolean) => setChecks(Object.fromEntries(preview.mods.map((mod) => [mod.key, mod.downloadable && checked])));

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await ModApi.applyPack(serverId, folder.key, preview.token, {
        skip: installable.filter((mod) => mod.selected && !checks[mod.key]).map((mod) => mod.key),
        include: installable.filter((mod) => !mod.selected && checks[mod.key]).map((mod) => mod.key),
        overrides: writesFiles && overrides,
      });
      notify.ok(`${preview.name} imported`, describeInstall(response));
      onApplied();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setExpired(true);
        setError("Upload the pack again.");
      }
      else setError(err instanceof Error ? err.message : String(err));
    }
    finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Content
      size="lg"
      title={`Import ${preview.name}${preview.version ? ` ${preview.version}` : ""}`}
      description={`${FORMAT_LABELS[preview.format]}${preview.gameVersion ? ` for ${preview.gameVersion}` : ""}${preview.loaders.length > 0 ? `, ${preview.loaders.join(", ")}` : ""}. Nothing is installed until you apply.`}
    >
      <Dialog.Body>
        <Stack gap="16">
          {preview.warnings.length > 0 && (
            <div className="mod-pack__warnings" role="alert">
              <Icon icon={TriangleAlert} />
              <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          )}

          <Stack gap="8">
            <div className="mod-pack__bar">
              <strong>{preview.mods.length === 1 ? "1 mod" : `${preview.mods.length} mods`}</strong>
              <span className="io-text-muted">{count} selected</span>
              <Stack direction="row" gap="4" className="mod-pack__bulk">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAll(true)}>Select all</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAll(false)}>Select none</Button>
              </Stack>
            </div>
            {preview.mods.length === 0
              ? <span className="io-text-muted">The pack lists no mods.</span>
              : <div className="mod-pack__mods">{preview.mods.map((mod) => <PackEntry key={mod.key} mod={mod} checked={checks[mod.key] ?? false} disabled={busy} onChange={(checked) => setChecks((current) => ({ ...current, [mod.key]: checked }))} />)}</div>}
          </Stack>

          {(writesFiles || preview.overrides.skipped.length > 0) && (
            <Stack gap="8">
              {writesFiles && (
                <>
                  <Checkbox
                    label="Also write the pack's config files"
                    description={`${preview.overrides.count} ${preview.overrides.count === 1 ? "file" : "files"}, ${formatBytes(preview.overrides.bytes)}. Files that already exist are replaced.`}
                    checked={overrides}
                    disabled={busy}
                    onCheckedChange={setOverrides}
                  />
                  <PathList paths={preview.overrides.sample} total={preview.overrides.count} />
                </>
              )}
              {preview.overrides.skipped.length > 0 && (
                <>
                  <span className="io-text-muted">Left out, because this game doesn't take files there:</span>
                  <PathList paths={preview.overrides.skipped} total={preview.overrides.skipped.length} />
                </>
              )}
            </Stack>
          )}

          {error && <span className="mod-manager__warning" role="alert">{error}</span>}
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close disabled={busy}>Cancel</Dialog.Close>
        <Button variant="primary" loading={busy} disabled={expired || (count === 0 && !(writesFiles && overrides))} onClick={apply}>
          {count === 1 ? "Install 1 mod" : `Install ${count} mods`}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  );
}

interface PackEntryProps {
  mod: ModPackEntryDto;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

function PackEntry(props: PackEntryProps) {
  const { mod, checked, disabled, onChange } = props;
  const source = mod.source === "included" ? "In the pack" : providerLabel(mod.source);
  return (
    <div className="mod-pack__mod" data-unavailable={mod.downloadable ? undefined : ""}>
      <Checkbox aria-label={`Install ${mod.title}`} checked={checked} disabled={disabled || !mod.downloadable} onCheckedChange={onChange} />
      <div className="mod-pack__text">
        <div className="mod-manager__title">
          <span className="mod-manager__name">{mod.title}</span>
          {mod.alreadyInstalled && <Badge size="sm" tone="ok">Already installed</Badge>}
          {mod.side === "client" && <Badge size="sm" tone="warn">Client only</Badge>}
          {mod.downloadable && !mod.selected && <Badge size="sm" tone="warn">Not selected</Badge>}
        </div>
        <span className="io-text-muted">
          {source}{mod.fileName && <> · <span className="io-mono">{mod.fileName}</span></>}{mod.size !== null && <> · {formatBytes(mod.size)}</>}
        </span>
        {/* Why it isn't installed by default (wrong loader, client-only) or at all must stand out, not read as a footnote. */}
        {mod.reason && <span className={mod.downloadable && mod.selected ? "io-text-muted" : "mod-manager__warning"}>{mod.reason}</span>}
      </div>
      {!mod.downloadable && mod.pageUrl && (
        <a className="mod-manager__link" href={mod.pageUrl} target="_blank" rel="noopener noreferrer">Download <Icon icon={ExternalLink} size="sm" /></a>
      )}
    </div>
  );
}

function PathList(props: { paths: string[]; total: number }) {
  const { paths, total } = props;
  return (
    <ul className="mod-manager__names">
      {paths.map((path) => <li key={path}>{path}</li>)}
      {total > paths.length && <li>and {total - paths.length} more</li>}
    </ul>
  );
}
