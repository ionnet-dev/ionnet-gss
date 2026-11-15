import { Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateEnrolTokenBody, EnrolTokenCreatedResponse, EnrolTokenDto } from "@shared/api/hosts.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, EnrolToken, User } from "../models/index.ts";

function pushEnrolTokenUpdated(enrolTokenId: number): void {
  LiveGateway.push("enrolToken.updated", { enrolTokenId }, { permission: "HOSTS_MANAGE" });
}

/**
 * The `gss-agent enrol` line for a token. Adds `--insecure` when PUBLIC_URL is plain http:// on a non-loopback host,
 * which the agent otherwise refuses.
 */
function enrolCommand(token: string): string {
  const url = new URL(Config.PUBLIC_URL);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1";
  const insecure = url.protocol === "http:" && !loopback ? " --insecure" : "";
  return `sudo gss-agent enrol --panel ${Config.PUBLIC_URL}${insecure} --token ${token}`;
}

/**
 * `/api/enrol-tokens` (HOSTS_MANAGE). The agent redeems a token over `/ws/agent` (`enrol`), not here.
 * Pushes `enrolToken.updated`. Audit: `enrol_token.created`, `enrol_token.revoked`.
 */
export namespace EnrolTokenController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ permissions: ["HOSTS_MANAGE"] }));

  /**
   * GET /api/enrol-tokens → EnrolTokenDto[] (newest first; used and expired included).
   */
  router.get("/", async (c) => {
    return c.json<EnrolTokenDto[]>((await EnrolToken.listAll()).map((token) => token.toClientJSON()));
  });

  /**
   * POST /api/enrol-tokens  CreateEnrolTokenBody → 201 EnrolTokenCreatedResponse. The token is shown once, with
   * `command` = `sudo gss-agent enrol --panel <PUBLIC_URL> [--insecure] --token <token>` (`enrolCommand`).
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateEnrolTokenBody>(c);
    const actor = c.var.user;
    const { enrolToken, token } = await EnrolToken.createToken(actor, { name: body.name, expiresInMinutes: body.expiresInMinutes });
    await AuditLog.record({ action: "enrol_token.created", actorId: actor.id, ip: clientIp(c), details: { enrolTokenId: enrolToken.id } });
    pushEnrolTokenUpdated(enrolToken.id);
    return c.json<EnrolTokenCreatedResponse>({
      enrolToken: enrolToken.toClientJSON(),
      token,
      command: enrolCommand(token),
    }, 201);
  });

  /**
   * DELETE /api/enrol-tokens/:id → OkResponse. Revokes an unused token; 409 once used.
   */
  router.delete("/:id", async (c) => {
    const id = paramInt(c, "id");
    const enrolToken = await EnrolToken.findByPk(id);
    if (!enrolToken) throw HttpError.notFound("There is no enrol token with that id.");
    if (enrolToken.usedAt !== null) throw HttpError.conflict("This token was already used and stays as history.");
    await enrolToken.destroy();
    await AuditLog.record({ action: "enrol_token.revoked", actorId: c.var.user.id, ip: clientIp(c), details: { enrolTokenId: id } });
    pushEnrolTokenUpdated(id);
    return c.json<OkResponse>({ ok: true });
  });
}

export default EnrolTokenController;
