/**
 * Game server orchestration: the only code that combines models, `DefinitionEngine` and `AgentGateway` for servers.
 * Controllers and agent handlers call it; it never sees a Hono `Context`.
 *
 * Access (M2): owner, or SERVERS_MANAGE_ALL. Create needs SERVERS_CREATE, a host grant (admins and
 * SERVERS_MANAGE_ALL skip it), `Quota.assertFits`, and host capacity. Settings change only while stopped.
 * Every state change the agent reports is stored on the row and pushed as `server.state`.
 */
import type {
  ConsoleBacklogResponse,
  CreateServerBody,
  GameServerDetailResponse,
  GameServerDto,
  UpdateServerBody,
  UpdateServerResponse,
} from "@shared/api/servers.ts";
import type { ConsoleBatch, ServerStatus, StateChange } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import type { GameServer, User } from "../models/index.ts";

export namespace GameServerService {
  //#region Queries
  /**
   * Servers the user may see (all for SERVERS_MANAGE_ALL), newest first.
   */
  export async function list(user: User): Promise<GameServerDto[]> {
    throw HttpError.notImplemented("GameServerService.list"); // TODO(builder): C
  }

  /**
   * The server if the user may access it. 404 (not 403) otherwise, so ids can't be probed.
   */
  export async function getAccessible(user: User, serverId: string): Promise<GameServer> {
    throw HttpError.notImplemented("GameServerService.getAccessible"); // TODO(builder): C
  }

  /**
   * Whether the user may access the server (live topic subscribe check). Never throws.
   */
  export async function canAccess(userId: number, serverId: string): Promise<boolean> {
    return false; // TODO(builder): C
  }

  export async function detail(user: User, serverId: string): Promise<GameServerDetailResponse> {
    throw HttpError.notImplemented("GameServerService.detail"); // TODO(builder): C
  }
  //#endregion

  //#region Lifecycle
  /**
   * Validate, allocate ports, store the row (state `creating`), then provision on the agent (409 when the host is
   * offline: the row is rolled back). Returns once the agent accepted; install continues and reports state events.
   */
  export async function create(user: User, body: CreateServerBody): Promise<GameServerDetailResponse> {
    throw HttpError.notImplemented("GameServerService.create"); // TODO(builder): C
  }

  /**
   * Name, variables, autostart, autoRestart. 409 unless stopped / install_failed / crashed. Re-provisions with the
   * new spec (reinstall when a `reinstall` variable changed).
   */
  export async function update(user: User, serverId: string, body: UpdateServerBody): Promise<UpdateServerResponse> {
    throw HttpError.notImplemented("GameServerService.update"); // TODO(builder): C
  }

  export async function start(user: User, serverId: string): Promise<GameServerDto> {
    throw HttpError.notImplemented("GameServerService.start"); // TODO(builder): C
  }

  export async function stop(user: User, serverId: string, kill: boolean): Promise<GameServerDto> {
    throw HttpError.notImplemented("GameServerService.stop"); // TODO(builder): C
  }

  export async function restart(user: User, serverId: string): Promise<GameServerDto> {
    throw HttpError.notImplemented("GameServerService.restart"); // TODO(builder): C
  }

  /**
   * Re-provision with `reinstall: true` (also the retry after install_failed). 409 while running.
   */
  export async function reinstall(user: User, serverId: string): Promise<GameServerDto> {
    throw HttpError.notImplemented("GameServerService.reinstall"); // TODO(builder): C
  }

  /**
   * Delete on the agent (409 when offline), then the row and its ports.
   */
  export async function remove(user: User, serverId: string, keepData: boolean): Promise<void> {
    throw HttpError.notImplemented("GameServerService.remove"); // TODO(builder): C
  }
  //#endregion

  //#region Console
  export async function input(user: User, serverId: string, line: string): Promise<void> {
    throw HttpError.notImplemented("GameServerService.input"); // TODO(builder): C
  }

  export async function backlog(user: User, serverId: string, limit: number): Promise<ConsoleBacklogResponse> {
    throw HttpError.notImplemented("GameServerService.backlog"); // TODO(builder): C
  }
  //#endregion

  //#region From the agent
  /**
   * `server.state` event: store state/reason/exitCode/stateChangedAt (installedAt on install → stopped), push
   * `server.state`. Ignores servers not on this host.
   */
  export async function applyStateChange(hostId: string, change: StateChange): Promise<void> {
    // TODO(builder): C
  }

  /**
   * `server.console` event: push to the `server:<id>` topic. Nothing is stored.
   */
  export function forwardConsole(hostId: string, batch: ConsoleBatch): void {
    // TODO(builder): C
  }

  /**
   * After `hello`: align rows with the agent's inventory. Known server → store its state; spec hash differs while
   * stopped → re-provision; row without agent state → provision; agent server unknown to the panel → log only (never
   * delete user data automatically).
   */
  export async function reconcile(hostId: string, servers: ServerStatus[]): Promise<void> {
    // TODO(builder): C
  }
  //#endregion
}

export default GameServerService;
