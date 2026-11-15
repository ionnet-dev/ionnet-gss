import { Hono } from "hono";
import type { DefinitionDto } from "@shared/api/definitions.ts";
import { type AppEnv, paramInt } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Definition, User } from "../models/index.ts";

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
    const definitions = await Definition.findAll({ where: { active: true }, include: [{ association: "source" }], order: [["name", "ASC"]] });
    const isAdmin = c.var.user.isAdmin();
    return c.json<DefinitionDto[]>(definitions.map((definition) => definition.toClientJSON(isAdmin)));
  });

  /**
   * GET /api/definitions/:id → DefinitionDto (any version, so a server's pinned one can be shown).
   */
  router.get("/:id", async (c) => {
    const id = paramInt(c, "id");
    const definition = await Definition.findByPk(id, { include: [{ association: "source" }] });
    if (!definition) throw HttpError.notFound("There is no game definition with that id.");
    return c.json<DefinitionDto>(definition.toClientJSON(c.var.user.isAdmin()));
  });
}

export default DefinitionController;
