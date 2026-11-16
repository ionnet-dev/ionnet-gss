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
import { TRANSFER_CHUNK_BYTES, TRANSFER_IDLE_SEC, TRANSFER_WINDOW } from "@shared/protocol/protocol.gen.ts";
import type { FileEntry, TransferOpenRequest, TransferOpenResponse } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { callAgent } from "../servers/agentCall.ts";

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
   * How long `transfer.commit` may take: it fsyncs the whole file before the rename.
   */
  const COMMIT_TIMEOUT_MS = TRANSFER_IDLE_SEC * 1000;

  /**
   * Seconds a 429 asks the browser to wait.
   */
  const RETRY_AFTER_SEC = 5;

  const _active = new Map<number, number>();

  /**
   * Open a download on the host and return a stream that pulls it chunk by chunk.
   * @param userId Counted against TRANSFERS_PER_USER until the stream ends, errors or is cancelled.
   * @throws HttpError 429 over TRANSFERS_PER_USER; the agent's refusal (404, 409 too many on the host…) through
   * `agentErrorToHttp`.
   */
  export async function openDownload(userId: number, hostId: string, source: DownloadSource): Promise<Download> {
    const release = acquire(userId);
    const transferId = crypto.randomUUID();
    let opened: TransferOpenResponse;
    try {
      opened = await callAgent(hostId, "transfer.open", openRequest(transferId, source, "download"));
    } catch (error) {
      release();
      closeQuietly(hostId, transferId); // A timed-out open may still have happened on the host.
      throw error;
    }
    const size = opened.size;
    let next = 0; // Offset of the next chunk to ask for.
    const inflight: Promise<Uint8Array>[] = []; // In offset order: requests go out in order and are taken in order.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
      closeQuietly(hostId, transferId);
    };
    const fetchChunk = (offset: number, length: number): Promise<Uint8Array> => {
      const chunk = callAgent(hostId, "transfer.read", { transferId, offset, length }).then((answer) => {
        const bytes = Uint8Array.fromBase64(answer.dataBase64);
        if (answer.offset !== offset || bytes.length !== length) {
          throw new HttpError(502, `The host sent ${bytes.length} of ${length} bytes at offset ${offset}; the file changed during the download.`);
        }
        return bytes;
      });
      chunk.catch(() => { }); // Awaited in order later; a chunk that fails after the stream ended mustn't go unhandled.
      return chunk;
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          while (inflight.length < TRANSFER_WINDOW && next < size) {
            const length = Math.min(TRANSFER_CHUNK_BYTES, size - next);
            inflight.push(fetchChunk(next, length));
            next += length;
          }
          const chunk = inflight.shift();
          if (chunk) controller.enqueue(await chunk);
          if (inflight.length === 0 && next >= size) {
            finish();
            controller.close();
          }
        } catch (error) {
          finish();
          console.warn(`download ${transferId} from host ${hostId} failed: ${(error as Error).message}`);
          controller.error(error);
        }
      },
      cancel: () => finish(),
    }, { highWaterMark: 0 });
    return { name: opened.name, size, stream };
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
    const release = acquire(userId);
    const transferId = crypto.randomUUID();
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => { });
    signal?.addEventListener("abort", onAbort, { once: true });
    let opened = false;
    let committed = false;
    let received = 0;
    try {
      if (signal?.aborted) throw cancelled();
      opened = true; // From here on a close is sent on failure (a timed-out open may have happened on the host).
      await callAgent(hostId, "transfer.open", openRequest(transferId, target, "upload"));

      // Writes in flight; each settles into `state.failure` instead of rejecting, so none goes unhandled.
      const inflight = new Set<Promise<void>>();
      const state: { failure: unknown } = { failure: null };
      let offset = 0;
      const buffer = new Uint8Array(TRANSFER_CHUNK_BYTES);
      let fill = 0;
      const flush = async () => {
        while (inflight.size >= TRANSFER_WINDOW) await Promise.race(inflight);
        if (state.failure) throw state.failure;
        // The base64 copy is made synchronously here, so `buffer` can be refilled right after.
        const write: Promise<void> = callAgent(hostId, "transfer.write", { transferId, offset, dataBase64: buffer.subarray(0, fill).toBase64() })
          .then(() => { inflight.delete(write); }, (error) => {
            state.failure ??= error;
            inflight.delete(write);
          });
        inflight.add(write);
        offset += fill;
        fill = 0;
      };

      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          throw signal?.aborted ? cancelled() : shortBody(received, target.size);
        }
        if (result.done) break;
        const value = result.value;
        received += value.length;
        if (received > target.size) throw HttpError.badRequest(`The upload is longer than its Content-Length of ${target.size} bytes.`);
        for (let pos = 0; pos < value.length;) {
          const n = Math.min(TRANSFER_CHUNK_BYTES - fill, value.length - pos);
          buffer.set(value.subarray(pos, pos + n), fill);
          fill += n;
          pos += n;
          if (fill === TRANSFER_CHUNK_BYTES) await flush();
        }
      }
      if (signal?.aborted) throw cancelled();
      if (received !== target.size) throw shortBody(received, target.size);
      if (fill > 0) await flush();
      await Promise.all(inflight);
      if (state.failure) throw state.failure;
      const entry = await callAgent(hostId, "transfer.commit", { transferId }, COMMIT_TIMEOUT_MS);
      committed = true;
      return entry;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      release();
      if (opened && !committed) closeQuietly(hostId, transferId);
      reader.cancel().catch(() => { });
    }
  }

  /**
   * Transfers the user has open right now (for the 429 check and tests).
   */
  export function activeFor(userId: number): number {
    return _active.get(userId) ?? 0;
  }

  /**
   * Count a transfer for the user, or 429 over TRANSFERS_PER_USER. Returns the release (safe to call twice).
   */
  function acquire(userId: number): () => void {
    const active = activeFor(userId);
    if (active >= Config.TRANSFERS_PER_USER) {
      throw HttpError.tooManyRequests(`You already have ${active} uploads or downloads running, the limit. Wait for one to finish and try again.`, RETRY_AFTER_SEC);
    }
    _active.set(userId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = activeFor(userId) - 1;
      if (left > 0) _active.set(userId, left);
      else _active.delete(userId);
    };
  }

  /**
   * Tell the host to drop a transfer (its temporary file for an upload). Best effort: a host that is gone closes it
   * on its own (idle timeout, next connection).
   */
  function closeQuietly(hostId: string, transferId: string): void {
    callAgent(hostId, "transfer.close", { transferId }).catch(() => { });
  }

  function cancelled(): HttpError {
    return HttpError.badRequest("The upload was cancelled.");
  }

  function shortBody(received: number, size: number): HttpError {
    return HttpError.badRequest(`The upload stopped after ${received} of ${size} bytes. Try again.`);
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
