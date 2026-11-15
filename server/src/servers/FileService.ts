/**
 * The file manager (M4): access (`manage`), light path checks, then the agent. The agent is the authority on paths
 * (it resolves everything beneath the data folder with `os.Root` and refuses escapes with `bad_request`); the panel
 * only refuses what is obviously malformed so a typo doesn't cost a round trip. Text content travels base64 to the
 * agent (files.json), plain UTF-8 to and from the browser.
 *
 * Every operation needs the host online (409 from `callAgent`) and a server that isn't `creating` or `deleting`
 * (409). Files can change while the game runs; the restore guard is the agent's (`conflict` while a restore swaps
 * the folder).
 */
import type { DownloadTicketResponse, FileContentResponse, FileEntryDto, FileListResponse } from "@shared/api/files.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { User } from "../models/index.ts";

export namespace FileService {
  /**
   * Longest path accepted from a browser, in characters.
   */
  export const PATH_MAX_CHARS = 4096;

  /**
   * A browser path, trimmed of leading/trailing slashes: a string, at most PATH_MAX_CHARS, no NUL or backslash, no
   * `.`/`..` segment. `""` is the data folder.
   * @param field Query or body field name, for the message.
   * @throws HttpError 400 naming the field.
   */
  export function cleanPath(value: unknown, field = "path"): string {
    throw new Error("Not implemented."); // TODO(builder)
  }

  export async function list(user: User, serverId: string, path: string): Promise<FileListResponse> {
    throw HttpError.notImplemented("FileService.list"); // TODO(builder): ServerAccess.get(manage) → callAgent files.list
  }

  /**
   * The file as text. 415 when the agent reports `binary`, 413 over FILE_TEXT_MAX_BYTES (from the agent's `too_large`).
   */
  export async function read(user: User, serverId: string, path: string): Promise<FileContentResponse> {
    throw HttpError.notImplemented("FileService.read"); // TODO(builder): files.read, decode base64 as UTF-8 (fatal)
  }

  /**
   * Save editor text. `modifiedAt` = the entry the editor loaded (409 when the file changed since); null creates or
   * overwrites unchecked.
   */
  export async function write(user: User, serverId: string, path: string, text: string, modifiedAt: string | null): Promise<FileEntryDto> {
    throw HttpError.notImplemented("FileService.write"); // TODO(builder): size check (413), base64, files.write
  }

  export async function mkdir(user: User, serverId: string, path: string): Promise<FileEntryDto> {
    throw HttpError.notImplemented("FileService.mkdir"); // TODO(builder)
  }

  export async function rename(user: User, serverId: string, from: string, to: string, overwrite: boolean): Promise<FileEntryDto> {
    throw HttpError.notImplemented("FileService.rename"); // TODO(builder)
  }

  /**
   * @param paths At most FILES_DELETE_MAX_PATHS (400); `""` refused (400).
   */
  export async function remove(user: User, serverId: string, paths: string[]): Promise<void> {
    throw HttpError.notImplemented("FileService.remove"); // TODO(builder)
  }

  /**
   * Stream an upload to the host (`TransferRelay.upload`).
   * @param size The request's Content-Length (411 when missing is the controller's job); over UPLOAD_MAX_MB → 413.
   */
  export async function upload(
    user: User,
    serverId: string,
    path: string,
    overwrite: boolean,
    size: number,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<FileEntryDto> {
    throw HttpError.notImplemented("FileService.upload"); // TODO(builder)
  }

  /**
   * A download ticket for one regular file: `files.stat` first (folders → 409 "Folders can't be downloaded; make a
   * backup instead."), then `DownloadTickets.issue`.
   */
  export async function downloadTicket(user: User, serverId: string, path: string): Promise<DownloadTicketResponse> {
    throw HttpError.notImplemented("FileService.downloadTicket"); // TODO(builder)
  }
}

export default FileService;
