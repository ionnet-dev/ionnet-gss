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
import { FILE_TEXT_MAX_BYTES, FILES_DELETE_MAX_PATHS } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { GameServer, User } from "../models/index.ts";
import { DownloadTickets } from "../transfers/DownloadTickets.ts";
import { TransferRelay } from "../transfers/TransferRelay.ts";
import { callAgent } from "./agentCall.ts";
import { ServerAccess } from "./ServerAccess.ts";

export namespace FileService {
  /**
   * Longest path accepted from a browser, in characters.
   */
  export const PATH_MAX_CHARS = 4096;

  /**
   * A browser path, trimmed of leading/trailing slashes: a string, at most PATH_MAX_CHARS, no NUL or backslash, no
   * `.`/`..` segment. `""` is the data folder. Doubled slashes collapse.
   * @param field Query or body field name, for the message.
   * @throws HttpError 400 naming the field.
   */
  export function cleanPath(value: unknown, field = "path"): string {
    if (typeof value !== "string") throw HttpError.badRequest(`"${field}" must be a path relative to the server's folder.`);
    if (value.length > PATH_MAX_CHARS) throw HttpError.badRequest(`"${field}" is longer than ${PATH_MAX_CHARS} characters.`);
    if (value.includes("\0")) throw HttpError.badRequest(`"${field}" contains a NUL character.`);
    if (value.includes("\\")) throw HttpError.badRequest(`"${field}" contains a backslash; use / between folders.`);
    const segments = value.split("/").filter((segment) => segment !== "");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw HttpError.badRequest(`"${field}" may not contain "." or ".." folders. The path leaves the server's folder.`);
    }
    return segments.join("/");
  }

  export async function list(user: User, serverId: string, path: string): Promise<FileListResponse> {
    const server = await reachable(user, serverId);
    return await callAgent(server.hostId, "files.list", { serverId: server.id, path });
  }

  /**
   * The file as text. 415 when the agent reports `binary`, 413 over FILE_TEXT_MAX_BYTES (from the agent's `too_large`).
   */
  export async function read(user: User, serverId: string, path: string): Promise<FileContentResponse> {
    const server = await reachable(user, serverId);
    const res = await callAgent(server.hostId, "files.read", { serverId: server.id, path });
    if (res.binary) throw notText(path);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.fromBase64(res.contentBase64));
    } catch {
      throw notText(path);
    }
    return { entry: res.entry, content };
  }

  /**
   * Save editor text. `modifiedAt` = the entry the editor loaded (409 when the file changed since); null creates or
   * overwrites unchecked.
   */
  export async function write(user: User, serverId: string, path: string, text: string, modifiedAt: string | null): Promise<FileEntryDto> {
    if (path === "") throw HttpError.badRequest("Name the file to save.");
    modifiedAt ||= null; // An empty query value means unchecked, like a missing one.
    if (modifiedAt !== null && Number.isNaN(Date.parse(modifiedAt))) {
      throw HttpError.badRequest("\"modifiedAt\" must be the modifiedAt the file was loaded with.");
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > FILE_TEXT_MAX_BYTES) throw editorTooLarge();
    const server = await reachable(user, serverId);
    return await callAgent(server.hostId, "files.write", {
      serverId: server.id,
      path,
      contentBase64: bytes.toBase64(),
      expectedModifiedAt: modifiedAt,
    });
  }

  export async function mkdir(user: User, serverId: string, path: string): Promise<FileEntryDto> {
    if (path === "") throw HttpError.badRequest("Name the folder to create.");
    const server = await reachable(user, serverId);
    return await callAgent(server.hostId, "files.mkdir", { serverId: server.id, path });
  }

  export async function rename(user: User, serverId: string, from: string, to: string, overwrite: boolean): Promise<FileEntryDto> {
    if (from === "" || to === "") throw HttpError.badRequest("The server's folder itself can't be renamed or replaced.");
    const server = await reachable(user, serverId);
    return await callAgent(server.hostId, "files.rename", { serverId: server.id, from, to, overwrite });
  }

  /**
   * @param paths At most FILES_DELETE_MAX_PATHS (400); `""` refused (400).
   */
  export async function remove(user: User, serverId: string, paths: string[]): Promise<void> {
    if (paths.length > FILES_DELETE_MAX_PATHS) throw HttpError.badRequest(`At most ${FILES_DELETE_MAX_PATHS} files and folders can be deleted at once.`);
    if (paths.includes("")) throw HttpError.badRequest("The server's folder itself can't be deleted; delete what is in it instead.");
    const server = await reachable(user, serverId);
    await callAgent(server.hostId, "files.delete", { serverId: server.id, paths });
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
    if (path === "") throw HttpError.badRequest("Name the file to upload.");
    if (size > Config.UPLOAD_MAX_MB * 1048576) throw HttpError.tooLarge(`Uploads are limited to ${Config.UPLOAD_MAX_MB} MB.`);
    const server = await reachable(user, serverId);
    return await TransferRelay.upload(user.id, server.hostId, { serverId: server.id, path, size, overwrite }, body, signal);
  }

  /**
   * A download ticket for one regular file: `files.stat` first (folders → 409 "Folders can't be downloaded; make a
   * backup instead."), then `DownloadTickets.issue`.
   */
  export async function downloadTicket(user: User, serverId: string, path: string): Promise<DownloadTicketResponse> {
    if (path === "") throw HttpError.conflict("Folders can't be downloaded; make a backup instead.");
    const server = await reachable(user, serverId);
    const entry = await callAgent(server.hostId, "files.stat", { serverId: server.id, path });
    if (entry.type === "dir") throw HttpError.conflict("Folders can't be downloaded; make a backup instead.");
    if (entry.type === "other") throw HttpError.conflict(`"${entry.name}" is a socket, device or pipe, not a file, so it can't be downloaded.`);
    return DownloadTickets.issue({
      userId: user.id,
      hostId: server.hostId,
      source: { serverId: server.id, source: "file", path },
      fileName: entry.name,
    });
  }

  /**
   * The server, if the user holds `manage` on it and it has a folder on its host (not `creating` / `deleting`).
   * @throws HttpError 404 (access), 409 (state).
   */
  async function reachable(user: User, serverId: string): Promise<GameServer> {
    const server = await ServerAccess.get(user, serverId, "manage");
    if (server.state === "creating") throw HttpError.conflict("The server is still being created on its host. Try again in a moment.");
    if (server.state === "deleting") throw HttpError.conflict("The server is being deleted.");
    return server;
  }

  function notText(path: string): HttpError {
    return new HttpError(415, `"${path}" isn't a UTF-8 text file, so the editor can't open it. Download it instead.`);
  }

  function editorTooLarge(): HttpError {
    return HttpError.tooLarge(`The editor saves files of at most ${FILE_TEXT_MAX_BYTES / 1048576} MB. Upload larger files instead.`);
  }
}

export default FileService;
