import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateInviteBody, InviteCreatedResponse, InviteDto } from "@shared/api/invites.ts";
import { ROLES } from "@shared/permissions.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, Invite, Role, User } from "../models/index.ts";

function pushInviteUpdated(inviteId: number): void {
  LiveGateway.push("invite.updated", { inviteId }, { permission: "INVITES_MANAGE" });
}

/**
 * `/api/invites` (INVITES_MANAGE). Pushes `invite.updated`. Audit: `invite.created`, `invite.revoked`.
 */
export namespace InviteController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ permissions: ["INVITES_MANAGE"] }));

  /**
   * GET /api/invites → InviteDto[] (newest first, used and expired included).
   */
  router.get("/", async (c) => {
    return c.json<InviteDto[]>((await Invite.listAll()).map((invite) => invite.toClientJSON()));
  });

  /**
   * POST /api/invites  CreateInviteBody → 201 InviteCreatedResponse (the code is shown once). 400 unknown role.
   * Only admins may invite into `admin`; others only into roles whose permissions they hold (403).
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateInviteBody>(c);
    const actor = c.var.user;
    if (body.role === ROLES.ADMIN && !actor.isAdmin()) throw HttpError.forbidden("Only administrators can invite into the admin role.");
    const roleName = body.role ?? ROLES.USER;
    const role = typeof roleName === "string" ? await Role.getRoleByName(roleName) : null;
    if (role) await actor.assertMayAssignRoles([role]); // An unknown role is a 400 from createInvite.
    const { invite, code } = await Invite.createInvite(actor, { email: body.email, roleName: body.role, expiresInHours: body.expiresInHours });
    await AuditLog.record({ action: "invite.created", actorId: actor.id, ip: clientIp(c), details: { inviteId: invite.id, role: invite.role?.name ?? null } });
    pushInviteUpdated(invite.id);
    return c.json<InviteCreatedResponse>({
      invite: invite.toClientJSON(),
      code,
      url: `${Config.PUBLIC_URL}/register?code=${encodeURIComponent(code)}`,
    }, 201);
  });

  /**
   * DELETE /api/invites/:id → OkResponse. Revokes an unused invite; used ones stay as history (409).
   */
  router.delete("/:id", async (c) => {
    const id = paramInt(c, "id");
    const invite = await Invite.findByPk(id);
    if (!invite) throw HttpError.notFound("There is no invite with that id.");
    if (invite.usedAt !== null) throw HttpError.conflict("This invite was already used and stays as history.");
    await invite.destroy();
    await AuditLog.record({ action: "invite.revoked", actorId: c.var.user.id, ip: clientIp(c), details: { inviteId: id } });
    pushInviteUpdated(id);
    return c.json<OkResponse>({ ok: true });
  });
}

export default InviteController;
