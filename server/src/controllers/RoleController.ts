import { Hono } from "hono";
import type { RoleDto } from "@shared/api/users.ts";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Role, User } from "../models/index.ts";

/**
 * `/api/roles`: the role list for user and invite forms (USERS_MANAGE or INVITES_MANAGE). Roles are seeded; editing
 * them is not in v1.
 */
export namespace RoleController {
  export const router = new Hono<AppEnv>();

  /**
   * GET /api/roles → RoleDto[] (with `inherits` resolved to a name).
   */
  router.get("/", User.$middleware(), async (c) => {
    const user = c.var.user;
    if (!user.hasPermission("USERS_MANAGE") && !user.hasPermission("INVITES_MANAGE")) throw HttpError.forbidden();
    const roles = await Role.findAll({ include: [{ association: "inherits" }], order: [["name", "ASC"]] });
    return c.json<RoleDto[]>(roles.map((role) => role.toClientJSON()));
  });
}

export default RoleController;
