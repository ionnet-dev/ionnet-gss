import { Hono } from "hono";
import type { DefinitionDto, VariableOptionsResponse } from "@shared/api/definitions.ts";
import { OptionsFetcher } from "../definitions/OptionsFetcher.ts";
import { type AppEnv, paramInt } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Definition, User } from "../models/index.ts";

/**
 * `/api/definitions`: active definition versions of enabled sources for the create form. Signed in. `admin_only` variables are dropped
 * for non-admins (see `DefinitionDto`).
 */
export namespace DefinitionController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/definitions → DefinitionDto[] (active only, by name).
   */
  router.get("/", async (c) => {
    const definitions = await Definition.findAll({ where: { active: true }, include: [{ association: "source", where: { enabled: true }, required: true }], order: [["name", "ASC"]] });
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

  /**
   * GET /api/definitions/:id/options/:key → VariableOptionsResponse (M3). 404 unknown variable, 400 when it has no
   * `options_from`; `admin_only` variables 404 for non-admins. A failed fetch's cause is shown to admins only.  
   * A list that names other variables takes their current values from the query (`?version=1.21.4`); a missing one
   * uses its default, and one its variable wouldn't accept is a 400.
   */
  router.get("/:id/options/:key", async (c) => {
    const id = paramInt(c, "id");
    const definition = await Definition.findByPk(id);
    if (!definition) throw HttpError.notFound("There is no game definition with that id.");
    const decl = (definition.document.variables ?? []).find((variable) => variable.key === c.req.param("key"));
    if (!decl || (decl.admin_only && !c.var.user.isAdmin())) throw HttpError.notFound("This game has no such variable.");
    const decls = definition.document.variables ?? [];
    // A non-admin can't see admin-only settings, so can't probe their lists through a dependent one: their defaults apply.
    const query = c.req.query();
    const given = c.var.user.isAdmin() ? query : Object.fromEntries(Object.entries(query).filter(([key]) => !decls.find((other) => other.key === key)?.admin_only));
    const result = await OptionsFetcher.getOptions(decl, await OptionsFetcher.dependencyValues(decl, decls, given));
    // The fetch error can name internal details (redirect targets, TLS and DNS errors): only admins see it.
    if (result.error !== null && !c.var.user.isAdmin()) result.error = OptionsFetcher.GENERIC_ERROR;
    return c.json<VariableOptionsResponse>(result);
  });
}

export default DefinitionController;
