import { type FormEvent, useState } from "react";
import { Button, Checkbox, Dialog, Input, Stack } from "@ionnet/iontronic/react";
import type { CreateSourceBody, SourceDto, UpdateSourceBody } from "@shared/api/sources.ts";
import { SourceApi } from "@/Api/SourceApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";

type Field = "name" | "url" | "branch" | "path" | "token" | "interval";
type Errors = Partial<Record<Field, string>>;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SourceDialogProps {
  /**
   * The source to edit; omitted to add one.
   */
  source?: SourceDto;
  onClose: () => void;
  /**
   * Called after a save, so the list can refetch.
   */
  onSaved: () => Promise<void>;
}

/**
 * Add or edit a git source. The panel's validation messages (bad URL, taken name, …) show under the field they name.
 * The token is write-only: an edit shows whether one is set and keeps it unless a new one is typed or it's removed.
 */
export default function SourceDialog(props: SourceDialogProps) {
  const { source, onClose, onSaved } = props;
  const notify = useNotify();
  const [name, setName] = useState(source?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? "https://");
  const [branch, setBranch] = useState(source?.branch ?? "main");
  const [path, setPath] = useState(source?.path ?? "");
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [intervalText, setIntervalText] = useState(source?.syncIntervalMin ? String(source.syncIntervalMin) : "");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editing = source !== undefined;
  const hasToken = editing && source.hasToken && !removeToken;

  const check = (): Errors => {
    const found: Errors = {};
    if (!NAME_PATTERN.test(name.trim()) || name.trim() === "builtin") found.name = "Use lowercase letters, numbers and dashes, starting with a letter or number. \"builtin\" is taken.";
    if (!/^https:\/\/[^\s/]+/i.test(url.trim())) found.url = "Enter an https:// address. Other kinds of address aren't allowed.";
    if (intervalText.trim() !== "" && (!Number.isInteger(Number(intervalText)) || Number(intervalText) < 1)) found.interval = "Enter a whole number of minutes, or leave it empty for the default.";
    return found;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = check();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const syncIntervalMin = intervalText.trim() === "" ? null : Number(intervalText);
      if (editing) {
        const body: UpdateSourceBody = {
          name: name.trim(),
          url: url.trim(),
          branch: branch.trim() || "main",
          path: path.trim(),
          syncIntervalMin,
        };
        if (token !== "") body.token = token;
        else if (removeToken) body.token = null;
        await SourceApi.update(source.id, body);
        notify.ok("Source saved");
      }
      else {
        const body: CreateSourceBody = {
          name: name.trim(),
          url: url.trim(),
          branch: branch.trim() || "main",
          path: path.trim(),
          syncIntervalMin,
        };
        if (token !== "") body.token = token;
        await SourceApi.create(body);
        notify.ok("Source added", "Its games are being fetched now. They show up when the sync finishes.");
      }
      await onSaved();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const field = fieldFor(message);
      if (field) setErrors({ [field]: message });
      else setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content
        title={editing ? `Edit ${source.name}` : "Add a source"}
        description="A git repository with game folders in it. The panel fetches it over https and lists the games it finds."
      >
        <form onSubmit={submit} noValidate>
          <Dialog.Body>
            <Stack gap="16">
              <Input
                label="Name"
                description="Shown next to each game. Lowercase letters, numbers and dashes."
                required
                autoFocus
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={errors.name}
                disabled={busy}
              />
              <Input
                label="Repository address"
                description="An https:// address, for example https://github.com/you/games.git"
                required
                type="url"
                autoComplete="off"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                error={errors.url}
                disabled={busy}
              />
              <Stack direction="row" gap="12" wrap>
                <div style={{ flex: "1 1 10rem" }}>
                  <Input label="Branch" autoComplete="off" value={branch} onChange={(event) => setBranch(event.target.value)} error={errors.branch} disabled={busy} />
                </div>
                <div style={{ flex: "1 1 10rem" }}>
                  <Input
                    label="Folder"
                    description="Where the game folders are. Empty means the top of the repository."
                    placeholder="games"
                    autoComplete="off"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    error={errors.path}
                    disabled={busy}
                  />
                </div>
              </Stack>
              <Input
                label="Access token"
                description={hasToken
                  ? "A token is set. Type a new one to replace it, or leave this empty to keep it."
                  : "Only for private repositories. It is stored on the panel and never shown again."}
                type="password"
                autoComplete="new-password"
                placeholder={hasToken ? "Token set" : undefined}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                error={errors.token}
                disabled={busy || removeToken}
              />
              {editing && source.hasToken && (
                <Checkbox
                  label="Remove the saved token"
                  checked={removeToken}
                  onCheckedChange={(checked) => { setRemoveToken(checked); if (checked) setToken(""); }}
                  disabled={busy}
                />
              )}
              <Input
                label="Sync every"
                description="Minutes between automatic syncs. Empty uses the panel's default."
                type="number"
                min={1}
                inputMode="numeric"
                value={intervalText}
                onChange={(event) => setIntervalText(event.target.value)}
                error={errors.interval}
                disabled={busy}
                trailing={<span className="io-mono io-text-muted">min</span>}
              />
              <FormError>{formError}</FormError>
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy}>{editing ? "Save" : "Add source"}</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Pin a panel message to the field it is about, so it shows under that field.
 */
function fieldFor(message: string): Field | null {
  const lower = message.toLowerCase();
  if (/token|credential|authenticat/.test(lower)) return "token";
  if (/url|https|address|repository/.test(lower)) return "url";
  if (/branch/.test(lower)) return "branch";
  if (/folder|subfolder|\bpath\b/.test(lower)) return "path";
  if (/interval|minutes/.test(lower)) return "interval";
  if (/name/.test(lower)) return "name";
  return null;
}
