import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { DownloadTickets } from "../transfers/DownloadTickets.ts";
import { TransferRelay } from "../transfers/TransferRelay.ts";

/**
 * `GET /api/downloads/:ticket` (M4): public, the single-use ticket is the authorisation (`DownloadTickets`). Streams
 * `TransferRelay.openDownload` as the body with `Content-Length`, `Content-Type: application/octet-stream`,
 * `Content-Disposition: attachment; filename*=UTF-8''…` and `X-Content-Type-Options: nosniff`, so a user's file is
 * never rendered by the browser on the panel's origin. Unknown or expired ticket → 404; the host offline → 409.
 */
export namespace DownloadController {
  export const router = new Hono<AppEnv>();

  router.get("/:ticket", async (c) => {
    const grant = DownloadTickets.consume(c.req.param("ticket"));
    if (!grant) throw HttpError.notFound("This download link is unknown, used or expired. Start the download again.");
    const download = await TransferRelay.openDownload(grant.userId, grant.hostId, grant.source);
    return new Response(download.stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(download.size),
        "content-disposition": contentDisposition(grant.fileName),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  /**
   * `attachment` with an ASCII fallback name and the exact UTF-8 name (RFC 6266 / RFC 5987).
   */
  export function contentDisposition(fileName: string): string {
    const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }
}

export default DownloadController;
