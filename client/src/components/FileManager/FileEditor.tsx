import type { FileEntryDto } from "@shared/api/files.ts";

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
  const { entry } = props;
  // TODO(builder)
  return <span>{entry.path}</span>;
}
