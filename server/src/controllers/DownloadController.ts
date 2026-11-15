import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";

/**
 * `GET /api/downloads/:ticket` (M4): public, the single-use ticket is the authorisation (`DownloadTickets`). Streams
 * `TransferRelay.openDownload` as the body with `Content-Length`, `Content-Type: application/octet-stream`,
 * `Content-Disposition: attachment; filename*=UTF-8''…` and `X-Content-Type-Options: nosniff`, so a user's file is
 * never rendered by the browser on the panel's origin. Unknown or expired ticket → 404; the host offline → 409.
 */
export namespace DownloadController {
  export const router = new Hono<AppEnv>();

  router.get("/:ticket", async (c) => {
    throw HttpError.notImplemented("GET /api/downloads/:ticket"); // TODO(builder): consume → openDownload → new Response(stream, headers)
  });
}

export default DownloadController;
