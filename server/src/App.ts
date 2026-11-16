/**
 * The Hono app: error mapping, `/api`, the two WebSockets, and the web app on the same port (Vite proxied in
 * development, `client/dist` with an index.html fallback in production). Main-session only.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/deno";
import { proxy } from "hono/proxy";
import type { ErrorResponse } from "@shared/api/common.ts";
import { Config, isDevelopment } from "./Config.ts";
import { FILE_TEXT_MAX_BYTES } from "@shared/protocol/protocol.gen.ts";
import { ApiController } from "./controllers/ApiController.ts";
import { FileController } from "./controllers/FileController.ts";
import { ModController } from "./controllers/ModController.ts";
import { AgentGateway } from "./gateways/agent/AgentGateway.ts";
import { LiveGateway } from "./gateways/live/LiveGateway.ts";
import { HttpError } from "./lib/HttpError.ts";

export function createApp(): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.retryAfterSec !== null) c.header("Retry-After", String(error.retryAfterSec));
      return c.json<ErrorResponse>({ message: error.message }, error.status as 400);
    }
    console.error(`${c.req.method} ${c.req.path} failed`, error);
    return c.json<ErrorResponse>({ message: "Something went wrong on the panel. Check its log for details." }, 500);
  });

  const jsonLimit = bodyLimit({
    maxSize: Config.BODY_LIMIT_KB * 1024,
    onError: () => {
      throw HttpError.tooLarge(`The request body is larger than ${Config.BODY_LIMIT_KB} KB.`);
    },
  });
  // M4: the editor saves plain text up to FILE_TEXT_MAX_BYTES (+ slack for a final newline the browser adds).
  const textLimit = bodyLimit({
    maxSize: FILE_TEXT_MAX_BYTES + 1024,
    onError: () => {
      throw HttpError.tooLarge(`The editor saves files of at most ${FILE_TEXT_MAX_BYTES / 1048576} MB. Upload larger files instead.`);
    },
  });
  app.use("/api/*", (c, next) => {
    if (FileController.BODY_PATHS.UPLOAD.test(c.req.path)) return next(); // Streamed; FileService checks UPLOAD_MAX_MB.
    if (ModController.BODY_PATHS.UPLOAD.test(c.req.path)) return next(); // M9: streamed like file uploads.
    if (ModController.BODY_PATHS.PACKS.test(c.req.path)) return next(); // M9: streamed; ModPackService checks MOD_PACK_MAX_MB.
    if (FileController.BODY_PATHS.CONTENT.test(c.req.path)) return textLimit(c, next);
    return jsonLimit(c, next);
  });
  app.route("/api", ApiController.router);
  app.route("/ws", AgentGateway.router); // /ws/agent
  app.route("/ws", LiveGateway.router); // /ws/live

  if (isDevelopment()) {
    // The browser loads everything from :PORT; Vite's HMR socket connects to Vite directly (client/vite.config.ts).
    app.all("*", (c) => {
      const url = new URL(c.req.url);
      return proxy(`${Config.VITE_URL}${url.pathname}${url.search}`, { ...c.req, headers: c.req.header() }).catch(() =>
        c.text(`The Vite dev server isn't reachable at ${Config.VITE_URL}. Start it with \`deno task dev\`.`, 502)
      );
    });
  }
  else {
    app.use("*", serveStatic({ root: Config.CLIENT_DIST }));
    app.get("*", serveStatic({ path: `${Config.CLIENT_DIST}/index.html` }));
  }

  return app;
}

export default createApp;
