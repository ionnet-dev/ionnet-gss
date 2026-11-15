import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateSourceBody, SourceDto, SyncSourceResponse, UpdateSourceBody } from "@shared/api/sources.ts";
import { type AppEnv, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { User } from "../models/index.ts";

/**
 * `/api/sources` (SOURCES_MANAGE). Pushes `source.updated` (and `definitions.updated` after a sync that changed
 * something). Audit: `source.created`, `source.updated`, `source.deleted`, `source.synced`.
 */
export namespace SourceController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ permissions: ["SOURCES_MANAGE"] }));

  /**
   * GET /api/sources → SourceDto[] (builtin first, then by name).
   */
  router.get("/", async (c) => {
    throw HttpError.notImplemented("GET /api/sources"); // TODO(builder): C
  });

  /**
   * POST /api/sources  CreateSourceBody → 201 SourceDto (kind git; first sync starts in the background). 400 bad
   * URL/branch/path/name, 409 name taken.
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateSourceBody>(c);
    throw HttpError.notImplemented("POST /api/sources"); // TODO(builder): C
  });

  /**
   * PATCH /api/sources/:id  UpdateSourceBody → SourceDto. The built-in source accepts only `enabled`.
   */
  router.patch("/:id", async (c) => {
    const id = paramInt(c, "id");
    const body = await readBody<UpdateSourceBody>(c);
    throw HttpError.notImplemented("PATCH /api/sources/:id"); // TODO(builder): C
  });

  /**
   * DELETE /api/sources/:id → OkResponse. 409 for the built-in source or while servers are pinned to its definitions
   * (disable it instead). Deletes the clone folder.
   */
  router.delete("/:id", async (c) => {
    const id = paramInt(c, "id");
    throw HttpError.notImplemented("DELETE /api/sources/:id"); // TODO(builder): C
  });

  /**
   * POST /api/sources/:id/sync → SyncSourceResponse. 409 while a sync of it runs.
   */
  router.post("/:id/sync", async (c) => {
    const id = paramInt(c, "id");
    throw HttpError.notImplemented("POST /api/sources/:id/sync"); // TODO(builder): C
  });
}

export default SourceController;
