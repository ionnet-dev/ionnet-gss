/**
 * `/api/servers/:id/files` (M4): the file manager. Access: `manage` (owner, SERVERS_MANAGE_ALL, or a share with role
 * `manage`); 404 otherwise. Paths are relative to the server's data folder (`""` = the folder itself), `/`-separated;
 * the agent refuses anything that leads out of it (400). Every route needs the host online (409).
 *
 * Downloads go through a short-lived ticket so the browser's own download manager can stream them:
 * `POST …/files/download` → `{ url }` → plain `GET <url>` (no Authorization header; single use, 60 s).
 */
import type { FileEntry } from "../protocol/protocol.gen.ts";

/**
 * One entry, as the agent reports it (`modifiedAt` is passed back unchanged when saving).
 */
export type FileEntryDto = FileEntry;

/**
 * `GET /api/servers/:id/files?path=<folder>`.
 */
export interface FileListResponse {
  path: string; // The listed folder, cleaned.
  entries: FileEntryDto[]; // Folders first, then by name.
  truncated: boolean; // More than FILES_LIST_MAX_ENTRIES entries; only the first are listed.
}

/**
 * `GET /api/servers/:id/files/content?path=<file>`: a text file for the editor. 413 over FILE_TEXT_MAX_BYTES, 415 when
 * it isn't UTF-8 text (download it instead).
 */
export interface FileContentResponse {
  entry: FileEntryDto;
  content: string;
}

/**
 * `PUT /api/servers/:id/files/content?path=<file>&modifiedAt=<entry.modifiedAt>` with the raw text as the body
 * (`Content-Type: text/plain; charset=utf-8`, at most FILE_TEXT_MAX_BYTES) → `FileEntryDto`. Without `modifiedAt` the
 * file is created or overwritten unchecked; with it, a file changed since → 409.
 */
export interface SaveFileQuery {
  path: string;
  modifiedAt?: string;
}

/**
 * `POST /api/servers/:id/files/folder` → 201 `FileEntryDto`; 409 the name is taken.
 */
export interface CreateFolderBody {
  path: string;
}

/**
 * `POST /api/servers/:id/files/rename` → `FileEntryDto`; 409 the target exists (without `overwrite`).
 */
export interface RenameFileBody {
  from: string;
  to: string; // Full new path; a move when the folder differs.
  overwrite?: boolean; // Replace an existing file (never a folder). Default false.
}

/**
 * `POST /api/servers/:id/files/delete` → `OkResponse`. Folders go recursively.
 */
export interface DeleteFilesBody {
  paths: string[]; // At most FILES_DELETE_MAX_PATHS.
}

/**
 * `PUT /api/servers/:id/files/upload?path=<file>&overwrite=true` with the file as the raw body. `Content-Length` is
 * required (411); over UPLOAD_MAX_MB → 413; host disk or the server's disk limit → 507; the file exists and
 * `overwrite` isn't set → 409. → 201 `FileEntryDto`.
 */
export interface UploadFileQuery {
  path: string;
  overwrite?: boolean;
}

/**
 * `POST /api/servers/:id/files/download` → `DownloadTicketResponse`. Files only (folders: make a backup).
 */
export interface DownloadFileBody {
  path: string;
}

/**
 * A single-use download link (`/api/downloads/<ticket>`), valid for `expiresAt`. Also returned by
 * `POST /api/servers/:id/backups/:backupId/download`.
 */
export interface DownloadTicketResponse {
  url: string; // Absolute path on the panel, e.g. "/api/downloads/AbC…".
  expiresAt: string;
}
