/**
 * Relays file bytes between a browser (plain HTTP) and a host's agent (the agent WebSocket), without buffering a whole
 * file in the panel. The agent never accepts connections, so every byte goes through the agent channel as
 * base64 chunks of at most TRANSFER_CHUNK_BYTES (files.json):
 *
 *   download  transfer.open ─► ReadableStream whose pull() keeps up to TRANSFER_WINDOW `transfer.read` requests in
 *             flight (offset-based, so order is restored by offset) ─► the HTTP response body (Content-Length = size,
 *             so a browser notices a cut-off download). Cancel (browser gone) or an error → `transfer.close`.
 *   upload    transfer.open { size } ─► the request body re-chunked to TRANSFER_CHUNK_BYTES, up to TRANSFER_WINDOW
 *             `transfer.write` in flight (reading the body only as fast as the agent acknowledges: backpressure) ─►
 *             `transfer.commit` ─► FileEntry. A body shorter or longer than `size`, an aborted request or any
 *             agent error → `transfer.close` (the agent removes its temporary file) and the error.
 *
 * Panel memory per transfer is bounded by the window: about TRANSFER_WINDOW × 683 KiB of base64. A host that drops
 * rejects every pending request ("The host disconnected."), which errors the stream; the agent closes its side after
 * TRANSFER_IDLE_SEC or on its next connection.
 *
 * Callers (FileService, BackupService) check access first; this module only moves bytes and counts transfers per
 * user against TRANSFERS_PER_USER (429).
 */
import type { FileEntry, TransferOpenRequest } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";

export namespace TransferRelay {
  /**
   * A download ready to be sent as a response body.
   */
  export interface Download {
    name: string; // Base name from the agent (FileService/BackupService pick the Content-Disposition name).
    size: number; // Content-Length.
    stream: ReadableStream<Uint8Array>;
  }

  /**
   * What a download reads: a data-folder file or a backup archive. `transferId` and `direction` are filled in here.
   */
  export type DownloadSource =
    | { serverId: string; source: "file"; path: string }
    | { serverId: string; source: "backup"; backupId: number };

  export interface UploadTarget {
    serverId: string;
    path: string;
    size: number; // Exact byte count (Content-Length).
    overwrite: boolean;
  }

  /**
   * Open a download on the host and return a stream that pulls it chunk by chunk.
   * @param userId Counted against TRANSFERS_PER_USER until the stream ends, errors or is cancelled.
   * @throws HttpError 429 over TRANSFERS_PER_USER; the agent's refusal (404, 409 too many on the host…) through
   * `agentErrorToHttp`.
   */
  export async function openDownload(userId: number, hostId: string, source: DownloadSource): Promise<Download> {
    throw HttpError.notImplemented("TransferRelay.openDownload"); // TODO(builder): transfer.open + pull-based ReadableStream (see the module doc).
  }

  /**
   * Stream `body` to the host as `target.path` and commit it.
   * @param signal The HTTP request's abort signal: an aborted upload closes the transfer at once.
   * @throws HttpError 400 when the body length differs from `target.size`, 429 over TRANSFERS_PER_USER, or the
   * agent's refusal (409 exists, 507 no space…).
   */
  export async function upload(
    userId: number,
    hostId: string,
    target: UploadTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<FileEntry> {
    throw HttpError.notImplemented("TransferRelay.upload"); // TODO(builder): open, windowed writes, commit; close on any failure.
  }

  /**
   * Transfers the user has open right now (for the 429 check and tests).
   */
  export function activeFor(userId: number): number {
    return 0; // TODO(builder): per-user counter.
  }

  /**
   * The `transfer.open` request for a source (exported for tests).
   */
  export function openRequest(transferId: string, source: DownloadSource | UploadTarget, direction: "download" | "upload"): TransferOpenRequest {
    if (direction === "upload") {
      const target = source as UploadTarget;
      return { transferId, serverId: target.serverId, direction, source: "file", path: target.path, size: target.size, overwrite: target.overwrite };
    }
    const from = source as DownloadSource;
    return from.source === "file"
      ? { transferId, serverId: from.serverId, direction, source: "file", path: from.path }
      : { transferId, serverId: from.serverId, direction, source: "backup", backupId: from.backupId };
  }
}

export default TransferRelay;
