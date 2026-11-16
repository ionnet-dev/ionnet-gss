import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateHostGrantBody, HostDetailResponse, HostDto, HostGrantDto, UpdateHostBody } from "@shared/api/hosts.ts";
import { LIMITS } from "@shared/constants.ts";
import { CLOSE_REVOKED } from "@shared/protocol/protocol.gen.ts";
import { AgentGateway } from "../gateways/agent/AgentGateway.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, paramUuid, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { parsePortPool } from "../lib/portPool.ts";
import { AuditLog, GameServer, Host, User } from "../models/index.ts";

const GRANTS_INCLUDE = { association: "grants", include: [{ association: "user" }], required: false };

/**
 * Hosts the caller may see: every host with HOSTS_MANAGE, otherwise the granted ones with HOSTS_VIEW (none in M1).
 */
async function findVisibleHost(user: User, id: string): Promise<Host> {
  const manage = user.hasPermission("HOSTS_MANAGE");
  const host = await Host.findByPk(id, { include: [manage ? GRANTS_INCLUDE : { association: "grants", where: { userId: user.id }, required: true }] });
  if (!host || (!manage && !user.hasPermission("HOSTS_VIEW"))) throw HttpError.notFound("There is no host with that id.");
  return host;
}

async function serverCount(hostId: string): Promise<number> {
  return await GameServer.count({ where: { hostId } });
}

async function detail(host: Host, user: User) {
  return host.toDetailJSON(AgentGateway.isOnline(host.id), await serverCount(host.id), user.hasPermission("HOSTS_MANAGE"));
}

function pushHostUpdated(host: Host): void {
  LiveGateway.push("host.updated", { hostId: host.id }, { permission: "HOSTS_MANAGE", userIds: (host.grants ?? []).map((grant) => grant.userId) });
}

/**
 * A capacity limit from the body: a positive whole number, or null to derive it from the host's facts.
 */
function parseLimit(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw HttpError.badRequest(`${label} must be a positive whole number, or null to use what the host reports.`);
  }
  return value;
}

/**
 * `/api/hosts`. HOSTS_MANAGE sees and edits every host; HOSTS_VIEW sees only granted hosts (M5; none in M1).
 * Online state comes from `AgentGateway.isOnline()`. Pushes `host.updated`. Audit: `host.updated`, `host.removed`.
 */
export namespace HostController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/hosts → HostDto[] (by name).
   */
  router.get("/", async (c) => {
    const user = c.var.user;
    const manage = user.hasPermission("HOSTS_MANAGE");
    if (!manage && !user.hasPermission("HOSTS_VIEW")) return c.json<HostDto[]>([]);
    const hosts = await Host.findAll({
      include: manage ? [] : [{ association: "grants", where: { userId: user.id }, required: true }],
      order: [["name", "ASC"]],
    });
    const counts = await GameServer.countByHost(manage ? undefined : hosts.map((host) => host.id));
    return c.json<HostDto[]>(hosts.map((host) => host.toClientJSON(AgentGateway.isOnline(host.id), counts.get(host.id) ?? 0)));
  });

  /**
   * GET /api/hosts/:id → HostDetailResponse. 404 when unknown or not visible to the caller.
   */
  router.get("/:id", async (c) => {
    const id = paramUuid(c, "id");
    return c.json<HostDetailResponse>(await detail(await findVisibleHost(c.var.user, id), c.var.user));
  });

  /**
   * PATCH /api/hosts/:id  UpdateHostBody → HostDetailResponse. HOSTS_MANAGE. 400 on a bad `portPool`
   * (`parsePortPool`). Disabling closes the agent socket with CLOSE_REVOKED.
   */
  router.patch("/:id", User.$middleware({ permissions: ["HOSTS_MANAGE"] }), async (c) => {
    const id = paramUuid(c, "id");
    const body = await readBody<UpdateHostBody>(c);
    const actor = c.var.user;
    const host = await findVisibleHost(actor, id);
    const changes: string[] = [];

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > LIMITS.HOST_NAME_MAX) throw HttpError.badRequest(`The host name must be 1-${LIMITS.HOST_NAME_MAX} characters long.`);
      host.name = name;
      changes.push("name");
    }
    if (body.address !== undefined) {
      if (body.address !== null && typeof body.address !== "string") throw HttpError.badRequest("The address must be a string, or null to use the host's hostname.");
      const address = body.address?.trim() || null;
      if (address !== null && address.length > 255) throw HttpError.badRequest("The address can be at most 255 characters long.");
      host.address = address;
      changes.push("address");
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") throw HttpError.badRequest("\"disabled\" must be true or false.");
      if (body.disabled !== host.disabled) changes.push("disabled");
      host.disabled = body.disabled;
    }
    if (body.portPool !== undefined) {
      if (typeof body.portPool !== "string") throw HttpError.badRequest("The port pool must be a string such as \"25565-25664,27015-27064\".");
      let ranges;
      try {
        ranges = parsePortPool(body.portPool);
      } catch (error) {
        throw HttpError.badRequest((error as Error).message);
      }
      if (ranges.length === 0) throw HttpError.badRequest("The port pool needs at least one port or range.");
      host.portPool = ranges.map((r) => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join(",");
      changes.push("portPool");
    }
    if (body.capacity !== undefined) {
      const capacity = body.capacity;
      if (capacity === null || typeof capacity !== "object") throw HttpError.badRequest("\"capacity\" must be an object.");
      if (capacity.maxMemoryMb !== undefined) host.maxMemoryMb = parseLimit(capacity.maxMemoryMb, "maxMemoryMb");
      if (capacity.maxCpuMillis !== undefined) host.maxCpuMillis = parseLimit(capacity.maxCpuMillis, "maxCpuMillis");
      if (capacity.maxDiskMb !== undefined) host.maxDiskMb = parseLimit(capacity.maxDiskMb, "maxDiskMb");
      changes.push("capacity");
    }

    await host.save();
    if (changes.includes("disabled") && host.disabled) AgentGateway.disconnect(host.id, CLOSE_REVOKED, "This host was disabled in the panel.");
    if (changes.length) await AuditLog.record({ action: "host.updated", actorId: actor.id, hostId: host.id, ip: clientIp(c), details: { changes } });
    pushHostUpdated(host);
    return c.json<HostDetailResponse>(await detail(host, actor));
  });

  /**
   * DELETE /api/hosts/:id → OkResponse. HOSTS_MANAGE. 409 while game servers exist on it. Closes the agent socket
   * with CLOSE_REVOKED, then deletes the row (the credential stops working).
   */
  router.delete("/:id", User.$middleware({ permissions: ["HOSTS_MANAGE"] }), async (c) => {
    const id = paramUuid(c, "id");
    const actor = c.var.user;
    const host = await findVisibleHost(actor, id);
    const servers = await serverCount(id);
    if (servers > 0) throw HttpError.conflict(`This host still has ${servers} game server${servers === 1 ? "" : "s"}. Delete them first.`);
    AgentGateway.disconnect(id, CLOSE_REVOKED, "This host was removed from the panel.");
    await host.destroy();
    await AuditLog.record({ action: "host.removed", actorId: actor.id, hostId: id, ip: clientIp(c), details: { name: host.name } });
    pushHostUpdated(host);
    return c.json<OkResponse>({ ok: true });
  });

  //#region Grants (M5)
  /**
   * GET /api/hosts/:id/grants → HostGrantDto[] (by username). HOSTS_MANAGE.
   */
  router.get("/:id/grants", User.$middleware({ permissions: ["HOSTS_MANAGE"] }), async (c) => {
    const id = paramUuid(c, "id");
    throw HttpError.notImplemented("GET /api/hosts/:id/grants"); // TODO(builder): M5
  });

  /**
   * POST /api/hosts/:id/grants  CreateHostGrantBody → 201 HostGrantDto. HOSTS_MANAGE. 404 unknown host or username,
   * 409 already granted. Audit `host.granted`; `host.updated` to HOSTS_MANAGE + granted users.
   */
  router.post("/:id/grants", User.$middleware({ permissions: ["HOSTS_MANAGE"] }), async (c) => {
    const id = paramUuid(c, "id");
    const body = await readBody<CreateHostGrantBody>(c);
    throw HttpError.notImplemented("POST /api/hosts/:id/grants"); // TODO(builder): M5
  });

  /**
   * DELETE /api/hosts/:id/grants/:userId → OkResponse. HOSTS_MANAGE. 404 when there is no such grant. The user's
   * servers on the host stay. Audit `host.revoked`; `host.updated` also to the revoked user.
   */
  router.delete("/:id/grants/:userId", User.$middleware({ permissions: ["HOSTS_MANAGE"] }), async (c) => {
    const id = paramUuid(c, "id");
    const userId = paramInt(c, "userId");
    throw HttpError.notImplemented("DELETE /api/hosts/:id/grants/:userId"); // TODO(builder): M5
  });
  //#endregion
}

export default HostController;
