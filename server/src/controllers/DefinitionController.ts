import { Hono } from "hono";
import type { DefinitionDto } from "@shared/api/definitions.ts";
import { type AppEnv, paramInt } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { User } from "../models/index.ts";

/**
 * `/api/definitions`: active definition versions for the create form. Signed in. `admin_only` variables are dropped
 * for non-admins (see `DefinitionDto`).
 */
export namespace DefinitionController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/definitions → DefinitionDto[] (active only, by name).
   */
  router.get("/", async (c) => {
    throw HttpError.notImplemented("GET /api/definitions"); // TODO(builder): C
  });

  /**
   * GET /api/definitions/:id → DefinitionDto (any version, so a server's pinned one can be shown).
   */
  router.get("/:id", async (c) => {
    const id = paramInt(c, "id");
    throw HttpError.notImplemented("GET /api/definitions/:id"); // TODO(builder): C
  });
}

export default DefinitionController;
