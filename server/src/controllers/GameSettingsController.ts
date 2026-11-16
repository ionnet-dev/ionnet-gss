import { type Context, Hono } from "hono";
import type { GameSettingsResponse, UpdateGameSettingsBody, UpdateGameSettingsResponse } from "@shared/api/gameSettings.ts";
import { type AppEnv, clientIp, paramUuid, readBody } from "../lib/http.ts";
import { AuditLog, User } from "../models/index.ts";
import { GameSettingsService } from "../servers/GameSettingsService.ts";

/**
 * `/api/servers/:id/game-settings`, mounted by `ApiController`. Thin: parse, call `GameSettingsService`, answer. Access
 * (`manage`) lives in the service. Audit: `game_settings.updated` (details: the files and the keys changed, never the
 * values, which can hold passwords).
 */
async function audit(c: Context<AppEnv>, serverId: string, details: Record<string, unknown>): Promise<void> {
  await AuditLog.record({ action: "game_settings.updated", actorId: c.var.user.id, serverId, hostId: null, ip: clientIp(c), details });
}

export namespace GameSettingsController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware());

  /**
   * GET /api/servers/:id/game-settings → GameSettingsResponse. 404 when the game has no game settings.
   */
  router.get("/", async (c) => {
    return c.json<GameSettingsResponse>(await GameSettingsService.get(c.var.user, paramUuid(c, "id")));
  });

  /**
   * PUT /api/servers/:id/game-settings  UpdateGameSettingsBody → UpdateGameSettingsResponse. 400 invalid value, 409 a
   * file changed since it was loaded.
   */
  router.put("/", async (c) => {
    const serverId = paramUuid(c, "id");
    const body = await readBody<UpdateGameSettingsBody>(c);
    const response = await GameSettingsService.update(c.var.user, serverId, body);
    await audit(c, serverId, { files: (body.files ?? []).map((change) => ({ file: change.file, keys: Object.keys(change.values ?? {}) })) });
    return c.json<UpdateGameSettingsResponse>(response);
  });
}

export default GameSettingsController;
