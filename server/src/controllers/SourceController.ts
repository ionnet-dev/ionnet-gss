import { type Context, Hono } from "hono";
import type { OkResponse } from "@shared/api/common.ts";
import type { CreateSourceBody, SourceDefinitionDto, SourceDto, SyncSourceResponse, UpdateSourceBody } from "@shared/api/sources.ts";
import { DefinitionSync } from "../definitions/DefinitionSync.ts";
import { GitLoader } from "../definitions/loaders/GitLoader.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { type AppEnv, clientIp, paramInt, readBody } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, Definition, GameServer, Source, User } from "../models/index.ts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/; // Visible ASCII: it goes into an HTTP header.
const MAX_INTERVAL_MIN = 525_600;

/**
 * `/api/sources` (SOURCES_MANAGE). Pushes `source.updated` (and `definitions.updated` after a sync that changed
 * something). Audit: `source.created`, `source.updated`, `source.deleted`, `source.synced`.
 */
export namespace SourceController {
  export const router = new Hono<AppEnv>();

  router.use("*", User.$middleware({ permissions: ["SOURCES_MANAGE"] }));

  // Syncs also run from the interval job, so the live events hang off `DefinitionSync`, not off the routes.
  DefinitionSync.onChange((change) => {
    LiveGateway.push("source.updated", { sourceId: change.sourceId, syncing: change.syncing }, { permission: "SOURCES_MANAGE" });
    if (change.definitionsChanged) LiveGateway.push("definitions.updated", { sourceId: change.sourceId }, { all: true });
  });

  /**
   * GET /api/sources → SourceDto[] (builtin first, then by name).
   */
  router.get("/", async (c) => {
    const sources = await Source.findAll();
    sources.sort((a, b) => a.name === Source.BUILTIN_NAME ? -1 : b.name === Source.BUILTIN_NAME ? 1 : a.name < b.name ? -1 : 1);
    return c.json<SourceDto[]>(await toDtos(sources));
  });

  /**
   * POST /api/sources  CreateSourceBody → 201 SourceDto (kind git; first sync starts in the background). 400 bad
   * URL/branch/path/name, 409 name taken.
   */
  router.post("/", async (c) => {
    const body = await readBody<CreateSourceBody>(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_PATTERN.test(name) || name === Source.BUILTIN_NAME) {
      throw HttpError.badRequest(`The name must be a slug of lowercase letters, digits and dashes (at most 63 characters) and can't be "${Source.BUILTIN_NAME}".`);
    }
    const url = checked(() => GitLoader.checkUrl(body.url as string));
    const branch = checked(() => GitLoader.checkBranch(body.branch ?? "main"));
    const path = checked(() => GitLoader.checkPath(body.path ?? ""));
    const token = parseToken(body.token);
    const syncIntervalMin = parseInterval(body.syncIntervalMin);
    if (await Source.count({ where: { name } }) > 0) throw HttpError.conflict(`There already is a source named "${name}".`);

    const source = await Source.create({
      name,
      kind: "git",
      url,
      branch,
      path,
      lastSyncAt: null,
      lastCommit: null,
      lastError: null,
      authToken: token ?? null,
      syncIntervalMin: syncIntervalMin ?? null,
    });
    await audit(c, "source.created", { sourceId: source.id, name, url, branch, path, hasToken: token !== undefined && token !== null });
    LiveGateway.push("source.updated", { sourceId: null, syncing: false }, { permission: "SOURCES_MANAGE" });
    startSync(source);
    return c.json(await toDto(source), 201);
  });

  /**
   * PATCH /api/sources/:id  UpdateSourceBody → SourceDto. The built-in source accepts only `enabled`.
   */
  router.patch("/:id", async (c) => {
    const id = paramInt(c, "id");
    const body = await readBody<UpdateSourceBody>(c);
    const source = await find(id);
    const changes: string[] = [];
    let resync = false;

    if (source.kind === "local") {
      const extra = Object.keys(body).filter((key) => key !== "enabled");
      if (extra.length) throw HttpError.badRequest("The built-in source can only be switched on or off.");
    }
    if (body.name !== undefined && body.name !== source.name) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!NAME_PATTERN.test(name) || name === Source.BUILTIN_NAME) throw HttpError.badRequest("The name must be a slug of lowercase letters, digits and dashes.");
      if (await Source.count({ where: { name } }) > 0) throw HttpError.conflict(`There already is a source named "${name}".`);
      source.name = name;
      changes.push("name");
    }
    let tokenCleared = false;
    if (body.url !== undefined) {
      const url = checked(() => GitLoader.checkUrl(body.url as string));
      if (url !== source.url) {
        // A token belongs to its host: moving the source elsewhere drops it unless a new one comes with the change.
        if (source.authToken !== null && body.token === undefined && new URL(url).host !== new URL(source.url).host) {
          source.authToken = null;
          tokenCleared = true;
          changes.push("token cleared (new host)");
        }
        source.url = url;
        changes.push("url");
        resync = true;
      }
    }
    if (body.branch !== undefined) {
      const branch = checked(() => GitLoader.checkBranch(body.branch as string));
      if (branch !== source.branch) {
        source.branch = branch;
        changes.push("branch");
        resync = true;
      }
    }
    if (body.path !== undefined) {
      const path = checked(() => GitLoader.checkPath(body.path as string));
      if (path !== source.path) {
        source.path = path;
        changes.push("path");
        resync = true;
      }
    }
    if (body.token !== undefined) {
      const token = parseToken(body.token);
      source.authToken = token ?? null;
      changes.push(token ? "token" : "token cleared");
      resync = true;
    }
    if (body.syncIntervalMin !== undefined) {
      source.syncIntervalMin = parseInterval(body.syncIntervalMin) ?? null;
      changes.push("syncIntervalMin");
    }
    let toggled = false;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw HttpError.badRequest("\"enabled\" must be true or false.");
      if (body.enabled !== source.enabled) {
        source.enabled = body.enabled;
        changes.push(body.enabled ? "enabled" : "disabled");
        toggled = true;
      }
    }
    if (changes.length === 0) return c.json(await toDto(source));

    await source.save();
    await audit(c, "source.updated", { sourceId: source.id, name: source.name, changes, ...(tokenCleared ? { tokenCleared: true } : {}) });
    LiveGateway.push("source.updated", { sourceId: source.id, syncing: DefinitionSync.isSyncing(source.id) }, { permission: "SOURCES_MANAGE" });
    if (toggled) LiveGateway.push("definitions.updated", { sourceId: source.id }, { all: true });
    // A sync already running read the old settings: queue another one after it.
    if (resync && source.enabled && source.kind === "git") DefinitionSync.resyncSoon(source);
    return c.json(await toDto(source));
  });

  /**
   * DELETE /api/sources/:id → OkResponse. 409 for the built-in source or while servers are pinned to its definitions
   * (disable it instead). Deletes the clone folder.
   */
  router.delete("/:id", async (c) => {
    const id = paramInt(c, "id");
    const source = await find(id);
    if (source.kind === "local") throw HttpError.conflict("The built-in source can't be removed. Switch it off instead.");
    if (DefinitionSync.isSyncing(id)) throw HttpError.conflict("This source is being synced. Try again when it has finished.");
    const pinned = await GameServer.count({ include: [{ association: "definition", attributes: [], where: { sourceId: id }, required: true }] });
    if (pinned > 0) {
      throw HttpError.conflict(`${pinned} game server${pinned === 1 ? " uses" : "s use"} definitions from this source. Delete them first, or switch the source off to stop offering its games.`);
    }
    await Definition.destroy({ where: { sourceId: id } });
    await source.destroy();
    await GitLoader.removeClone(id);
    await audit(c, "source.deleted", { sourceId: id, name: source.name, url: source.url });
    LiveGateway.push("source.updated", { sourceId: null, syncing: false }, { permission: "SOURCES_MANAGE" });
    LiveGateway.push("definitions.updated", { sourceId: id }, { all: true });
    return c.json<OkResponse>({ ok: true });
  });

  /**
   * POST /api/sources/:id/sync → SyncSourceResponse. 409 while a sync of it runs.
   */
  router.post("/:id/sync", async (c) => {
    const id = paramInt(c, "id");
    const source = await find(id);
    let synced: string[] = [];
    let failed: Record<string, string> = {};
    try {
      const result = await DefinitionSync.syncSource(source);
      synced = result.synced;
      failed = result.failed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // A source-level failure (clone, limits) is stored in `lastError` and shown from the source.
    }
    const fresh = await find(id);
    await audit(c, "source.synced", { sourceId: id, name: fresh.name, commit: fresh.lastCommit, synced: synced.length, failed: Object.keys(failed), error: fresh.lastError });
    return c.json<SyncSourceResponse>({ source: await toDto(fresh), synced, failed });
  });

  async function find(id: number): Promise<Source> {
    const source = await Source.findByPk(id);
    if (!source) throw HttpError.notFound("There is no source with that id.");
    return source;
  }

  /**
   * Sync in the background (the first sync of a new source, or after its address changed); failures are stored on the
   * source, so nothing is left to do with the result.
   */
  function startSync(source: Source): void {
    DefinitionSync.syncSource(source).catch((error) => console.warn(`sources: the sync of "${source.name}" failed: ${(error as Error).message}`));
  }

  /**
   * Run a validator from `GitLoader` and turn its error into a 400.
   */
  function checked<T>(check: () => T): T {
    try {
      return check();
    } catch (error) {
      throw HttpError.badRequest((error as Error).message);
    }
  }

  /**
   * undefined = not sent; null/"" = no token; otherwise the validated token.
   */
  function parseToken(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
      throw HttpError.badRequest("The token must be one line of visible characters, at most 512 long, without spaces.");
    }
    return value;
  }

  function parseInterval(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_INTERVAL_MIN) {
      throw HttpError.badRequest("\"syncIntervalMin\" must be a whole number of minutes (0 = only when you press Sync), or null for the panel's default.");
    }
    return value as number;
  }

  async function audit(c: Context<AppEnv>, action: string, details: Record<string, unknown>): Promise<void> {
    await AuditLog.record({ action, actorId: c.var.user.id, ip: clientIp(c), details });
  }

  async function toDto(source: Source): Promise<SourceDto> {
    return (await toDtos([source]))[0];
  }

  /**
   * DTOs with each source's active definitions and how many servers are pinned to each game (any version).
   */
  async function toDtos(sources: Source[]): Promise<SourceDto[]> {
    const ids = sources.map((source) => source.id);
    const definitions = await Definition.findAll({ where: { sourceId: ids, active: true }, attributes: ["id", "sourceId", "gameId", "name", "commit"], order: [["name", "ASC"]] });
    const servers = ids.length === 0 ? [] : await GameServer.findAll({
      attributes: ["id"],
      include: [{ association: "definition", attributes: ["sourceId", "gameId"], where: { sourceId: ids }, required: true }],
    });
    const counts = new Map<string, number>();
    for (const server of servers) {
      const key = `${server.definition!.sourceId}/${server.definition!.gameId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return sources.map((source) => source.toClientJSON({
      syncing: DefinitionSync.isSyncing(source.id),
      definitions: definitions.filter((definition) => definition.sourceId === source.id).map((definition): SourceDefinitionDto => ({
        definitionId: definition.id,
        gameId: definition.gameId,
        name: definition.name,
        commit: definition.commit,
        serverCount: counts.get(`${source.id}/${definition.gameId}`) ?? 0,
      })),
    }));
  }
}

export default SourceController;
