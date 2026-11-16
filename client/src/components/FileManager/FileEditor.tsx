import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { AlertDialog, Button, Dialog, Spinner, Stack, Textarea } from "@ionnet/iontronic/react";
import { Save, TriangleAlert } from "@ionnet/iontronic/icons";
import type { FileEntryDto } from "@shared/api/files.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { FileApi } from "@/Api/FileApi.ts";
import { useNotify } from "@/components/Notify/useNotify.ts";

export interface FileEditorProps {
  serverId: string;
  entry: FileEntryDto;
  onClose: () => void;
  onSaved: (entry: FileEntryDto) => void;
}

/**
 * Edit one text file (M4): loads `FileApi.read` (413/415 explain "download it instead"), a monospace `Textarea`,
 * Save sends the loaded `modifiedAt` (409 → "changed on the server: reload or overwrite"), warns before closing with
 * unsaved changes. A `Dialog` (a bottom sheet on phones).
 */
export default function FileEditor(props: FileEditorProps) {
  const { serverId, entry, onClose, onSaved } = props;
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<FileEntryDto>(entry); // The entry whose `modifiedAt` the next save checks.
  const [original, setOriginal] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const dirty = !loading && loadError === null && content !== original;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setConflict(false);
    try {
      const result = await FileApi.read(serverId, entry.path);
      setLoaded(result.entry);
      setOriginal(result.content);
      setContent(result.content);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) setLoadError("This file is too large to edit here. Download it instead.");
      else if (error instanceof ApiError && error.status === 415) setLoadError("This isn't a text file, so it can't be edited here. Download it instead.");
      else setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [serverId, entry.path]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (overwrite: boolean) => {
    setSaving(true);
    try {
      const saved = await FileApi.save(serverId, entry.path, content, overwrite ? undefined : loaded.modifiedAt);
      setLoaded(saved);
      setOriginal(content);
      setConflict(false);
      onSaved(saved);
      notify.ok(`${entry.name} saved`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && /since it was opened/.test(error.message)) setConflict(true);
      else notify.error(error, `Couldn't save ${entry.name}`);
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      if (dirty && !saving) save(false);
    }
  };

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && requestClose()}>
        <Dialog.Content size="lg" title={entry.name} description={entry.path}>
          <Dialog.Body>
            {loading && (
              <div className="file-editor__state" role="status">
                <Spinner /> Loading the file…
              </div>
            )}
            {!loading && loadError !== null && (
              <div className="file-editor__state" role="alert" data-error="">
                <TriangleAlert size={18} /> {loadError}
              </div>
            )}
            {!loading && loadError === null && (
              <Stack gap="12">
                {conflict && (
                  <div className="file-editor__conflict" role="alert">
                    <span>This file changed on the server since you opened it. Reload it (your edits are lost) or overwrite it with your version.</span>
                    <div className="file-editor__conflict-actions">
                      <Button size="sm" onClick={load}>Reload</Button>
                      <Button size="sm" variant="danger" loading={saving} onClick={() => save(true)}>Overwrite</Button>
                    </div>
                  </div>
                )}
                <Textarea
                  className="file-editor__text"
                  aria-label={`Content of ${entry.name}`}
                  mono
                  resize="none"
                  rows={18}
                  wrap="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </Stack>
            )}
          </Dialog.Body>
          <Dialog.Footer>
            <Button onClick={requestClose}>{dirty ? "Cancel" : "Close"}</Button>
            {loadError === null && <Button variant="primary" icon={Save} disabled={!dirty} loading={saving && !conflict} onClick={() => save(false)}>Save</Button>}
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
      <AlertDialog.Root open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialog.Content title="Discard your changes?" description={`${entry.name} has unsaved changes. Closing the editor throws them away.`}>
          <AlertDialog.Footer>
            <AlertDialog.Close>Keep editing</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={onClose}>Discard changes</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
