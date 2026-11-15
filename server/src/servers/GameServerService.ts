/**
 * Game server orchestration: the only code that combines models, `DefinitionEngine` and `AgentGateway` for servers.
 * Controllers and agent handlers call it; it never sees a Hono `Context`.
 *
 * Access (M2): owner, or SERVERS_MANAGE_ALL. Create needs SERVERS_CREATE, a host grant (admins and
 * SERVERS_MANAGE_ALL skip it), `Quota.assertFits`, and host capacity. Settings change only while stopped.
 * Every state change the agent reports is stored on the row and pushed as `server.state`.
 *
 * Deletes (and creates rolled back) leave the row as a tombstone in state `deleting`, ports still held, until the
 * agent confirms: a timed-out or interrupted delete is retried every minute while the host is online and after
 * every hello, and reconcile never provisions a tombstone again.
 */
import { Op, type Transaction } from "sequelize";
import type {
  ConsoleBacklogResponse,
  CreateServerBody,
  GameServerDetailResponse,
  GameServerDto,
  ServerVariableDto,
  UpdateServerBody,
  UpdateServerResponse,
} from "@shared/api/servers.ts";
import { LIMITS } from "@shared/constants.ts";
import {
  CONSOLE_BACKLOG_MAX_LINES,
  CONSOLE_LINE_MAX_BYTES,
  type ConsoleBatch,
  type ConsoleLine,
  type InstallProgress,
  type PanelToAgentRequests,
  type PortBinding,
  PROVISION_TIMEOUT_SEC,
  type ServerSpec,
  type ServerState,
  type ServerStatus,
  type StateChange,
} from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { DefinitionEngine } from "../definitions/DefinitionEngine.ts";
import { AgentGateway } from "../gateways/agent/AgentGateway.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { RateLimiter } from "../lib/RateLimiter.ts";
import { Definition, GameServer, Host, HostGrant, PortAllocation, Quota, sequelize, User } from "../models/index.ts";

type Value = DefinitionEngine.Value;
type Limits = ServerSpec["limits"];

export namespace GameServerService {
  /**
   * Limits of a server whose definition binds none of them.
   */
  export const DEFAULT_LIMITS: Limits = { memoryMb: 2048, cpuMillis: 2000, pids: 1024, diskMb: 10240 };

  /**
   * Memory kept free for the host itself when the admin set no memory capacity for it.
   */
  const MEMORY_RESERVE_MB = 1024;
  const SETTINGS_STATES: readonly ServerState[] = ["stopped", "install_failed", "crashed"];
  /**
   * The agent gives up on a provision after PROVISION_TIMEOUT_SEC and answers; the panel waits a little longer so
   * that answer (and not a panel-side timeout) decides.
   */
  const PROVISION_TIMEOUT_MS = (PROVISION_TIMEOUT_SEC + 30) * 1000;
  /**
   * Stop timeout of a definition that sets none (definition.json StopSpec), and what the agent adds for `docker stop`.
   */
  const DEFAULT_STOP_TIMEOUT_SEC = 30;
  const AGENT_STOP_GRACE_SEC = 15;
  /**
   * Margin on top of the stop budget for the rest of a restart or delete (container removal, cleanup, start).
   */
  const LIFECYCLE_MARGIN_SEC = 90;
  const DELETE_RETRY_MS = 60_000;
  const MAX_INPUT_CHARS = 1024;
  /**
   * Console commands per server and window, across every user of that server.
   */
  const _inputLimiter = new RateLimiter(30, 10, "console commands for this server");
  /**
   * Pending delete retries, by server id.
   */
  const _deleteRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Installs in flight, by server id: install progress arrives with events and is never stored on the row.
   */
  const _progress = new Map<string, InstallProgress>();
  /**
   * Servers whose `create` is still waiting for the agent (reconcile leaves them alone).
   */
  const _creating = new Set<string>();
  /**
   * Which host a server lives on, to check that a console batch comes from the right agent. Promises, so batches that
   * arrive while the first lookup runs stay in order.
   */
  const _hostOf = new Map<string, Promise<string | null>>();

  const FULL_INCLUDE = [
    { association: "owner", attributes: ["id", "username"] },
    { association: "host" },
    { association: "definition", include: [{ association: "source" }] },
    { association: "ports" },
  ];
  const LIST_INCLUDE = [
    { association: "owner", attributes: ["id", "username"] },
    { association: "host" },
    { association: "definition", attributes: ["id", "gameId", "name", "commit", "sourceId"] },
    { association: "ports" },
  ];

  //#region Queries
  /**
   * Servers the user may see (all for SERVERS_MANAGE_ALL), newest first.
   */
  export async function list(user: User): Promise<GameServerDto[]> {
    const servers = await GameServer.findAll({
      where: user.hasPermission("SERVERS_MANAGE_ALL") ? {} : { ownerId: user.id },
      include: LIST_INCLUDE,
      order: [["createdAt", "DESC"]],
    });
    return servers.map(toDto);
  }

  /**
   * The server if the user may access it. 404 (not 403) otherwise, so ids can't be probed.
   */
  export async function getAccessible(user: User, serverId: string): Promise<GameServer> {
    const server = await GameServer.findByPk(serverId, { include: FULL_INCLUDE });
    if (!server || (server.ownerId !== user.id && !user.hasPermission("SERVERS_MANAGE_ALL"))) {
      throw HttpError.notFound("There is no game server with that id.");
    }
    return server;
  }

  /**
   * Whether the user may access the server (live topic subscribe check). Never throws.
   */
  export async function canAccess(userId: number, serverId: string): Promise<boolean> {
    try {
      if (!UUID_PATTERN.test(serverId)) return false;
      const server = await GameServer.findByPk(serverId, { attributes: ["id", "ownerId"] });
      if (!server) return false;
      if (server.ownerId === userId) return true;
      const user = await User.findWithRoles({ id: userId });
      return user !== null && user.hasPermission("SERVERS_MANAGE_ALL");
    } catch (error) {
      console.error("server access check failed", error);
      return false;
    }
  }

  export async function detail(user: User, serverId: string): Promise<GameServerDetailResponse> {
    return await toDetail(user, await getAccessible(user, serverId));
  }
  //#endregion

  //#region Lifecycle
  /**
   * Validate, allocate ports, store the row (state `creating`), then provision on the agent (409 when the host is
   * offline: the row is rolled back). Returns once the agent accepted; install continues and reports state events.
   */
  export async function create(user: User, body: CreateServerBody): Promise<GameServerDetailResponse> {
    const name = parseName(body.name);
    if (typeof body.hostId !== "string" || !UUID_PATTERN.test(body.hostId)) throw HttpError.badRequest("\"hostId\" must be the id of a host.");
    if (!Number.isInteger(body.definitionId)) throw HttpError.badRequest("\"definitionId\" must be the id of a game definition.");
    const variables = parseVariables(body.variables);
    const autostart = parseFlag(body.autostart, "autostart") ?? true;
    const autoRestart = parseFlag(body.autoRestart, "autoRestart") ?? false;
    let pinned: Record<string, number> | undefined;
    if (body.ports !== undefined) {
      if (!user.hasPermission("PORTS_OVERRIDE")) throw HttpError.forbidden("You may not choose ports yourself.");
      if (typeof body.ports !== "object" || body.ports === null || Array.isArray(body.ports)) throw HttpError.badRequest("\"ports\" must be an object of port name to number.");
      pinned = body.ports;
    }

    const host = await Host.findByPk(body.hostId);
    if (!host) throw HttpError.notFound("There is no host with that id.");
    if (!await mayUseHost(user, host.id)) throw HttpError.forbidden("You may not create servers on this host. Ask an administrator for access.");
    if (host.disabled) throw HttpError.conflict(`The host "${host.name}" is disabled.`);
    if (!AgentGateway.isOnline(host.id)) throw offlineError(host);

    const definition = await Definition.findByPk(body.definitionId, { include: [{ association: "source" }] });
    if (!definition) throw HttpError.notFound("There is no game definition with that id.");
    if (!definition.active) throw HttpError.conflict("That version of the game definition is no longer offered. Reload the page to pick the current one.");

    const decls = definition.document.variables ?? [];
    const { values } = DefinitionEngine.resolveVariables(decls, variables, null, user.isAdmin());
    const limits = DefinitionEngine.resolveLimits(decls, values, DEFAULT_LIMITS);
    await Quota.assertFits(user.id, { servers: 1, memoryMb: limits.memoryMb, cpuMillis: limits.cpuMillis, diskMb: limits.diskMb });

    const id = crypto.randomUUID();
    const built = await sequelize.transaction(async (transaction) => {
      const locked = await Host.findByPk(host.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw HttpError.notFound("There is no host with that id.");
      await assertHostCapacity(locked, limits, null, transaction);
      const row = await GameServer.create({
        id,
        name,
        ownerId: user.id,
        hostId: host.id,
        definitionId: definition.id,
        stateReason: null,
        lastExitCode: null,
        variables: values,
        memoryMb: limits.memoryMb,
        cpuMillis: limits.cpuMillis,
        diskMb: limits.diskMb,
        autostart,
        autoRestart,
        specHash: null,
        installedAt: null,
      }, { transaction });
      const allocations = await PortAllocation.allocate(locked, id, definition.document.ports ?? [], transaction, pinned);
      const built = await specFor(definition, { id, name, variables: values, limits, autostart, autoRestart }, allocations);
      row.specHash = built.specHash;
      await row.save({ transaction });
      return built;
    });

    _creating.add(id);
    try {
      const status = await provision(host.id, built.spec, built.specHash, true);
      await storeStatus(id, status);
    } catch (error) {
      await rollbackCreate(id);
      throw error;
    } finally {
      _creating.delete(id);
    }
    pushUpdated(user.id, id);
    return await detail(user, id);
  }

  /**
   * Name, variables, autostart, autoRestart. 409 unless stopped / install_failed / crashed. Re-provisions with the
   * new spec (reinstall when a `reinstall` variable changed).
   */
  export async function update(user: User, serverId: string, body: UpdateServerBody): Promise<UpdateServerResponse> {
    const server = await getAccessible(user, serverId);
    if (server.state === "deleting") throw deletingError();
    if (!SETTINGS_STATES.includes(server.state)) {
      throw HttpError.conflict("Stop the server before changing its settings. They apply at the next start.");
    }
    const name = body.name === undefined ? server.name : parseName(body.name);
    const autostart = parseFlag(body.autostart, "autostart") ?? server.autostart;
    const autoRestart = parseFlag(body.autoRestart, "autoRestart") ?? server.autoRestart;
    const submitted = parseVariables(body.variables);
    const definition = server.definition!;
    const decls = definition.document.variables ?? [];
    const { values, reinstall } = DefinitionEngine.resolveVariables(decls, submitted, server.variables, user.isAdmin());
    const limits = DefinitionEngine.resolveLimits(decls, values, DEFAULT_LIMITS);

    const grown = {
      servers: 0,
      memoryMb: Math.max(0, limits.memoryMb - server.memoryMb),
      cpuMillis: Math.max(0, limits.cpuMillis - server.cpuMillis),
      diskMb: Math.max(0, limits.diskMb - server.diskMb),
    };
    if (grown.memoryMb || grown.cpuMillis || grown.diskMb) {
      await Quota.assertFits(server.ownerId, grown);
      await assertHostCapacity(server.host!, limits, server.id);
    }

    const built = await specFor(definition, { id: server.id, name, variables: values, limits, autostart, autoRestart }, server.ports!);
    if (built.specHash !== server.specHash || reinstall) {
      const status = await provision(server.hostId, built.spec, built.specHash, reinstall);
      await storeStatus(server.id, status);
    }
    await GameServer.update({
      name,
      variables: values,
      memoryMb: limits.memoryMb,
      cpuMillis: limits.cpuMillis,
      diskMb: limits.diskMb,
      autostart,
      autoRestart,
      specHash: built.specHash,
    }, { where: { id: server.id } });
    pushUpdated(server.ownerId, server.id);
    return { server: await detail(user, server.id), reinstallPending: reinstall };
  }

  export async function start(user: User, serverId: string): Promise<GameServerDto> {
    const server = await getAccessible(user, serverId);
    if (server.state !== "stopped" && server.state !== "crashed") throw notStartable(server.state);
    const status = await callAgent(server.hostId, "server.start", { serverId });
    await storeStatus(serverId, status);
    return await dtoOf(serverId);
  }

  export async function stop(user: User, serverId: string, kill: boolean): Promise<GameServerDto> {
    const server = await getAccessible(user, serverId);
    // Stopping an install cancels it (the server ends install_failed and can be reinstalled).
    if (server.state === "deleting") throw deletingError();
    const stoppable = server.state === "running" || server.state === "starting" || server.state === "installing" || (kill && server.state === "stopping");
    if (!stoppable) throw HttpError.conflict(server.state === "stopping" ? "The server is already stopping." : "The server isn't running.");
    const status = await callAgent(server.hostId, "server.stop", { serverId, kill });
    await storeStatus(serverId, status);
    return await dtoOf(serverId);
  }

  export async function restart(user: User, serverId: string): Promise<GameServerDto> {
    const server = await getAccessible(user, serverId);
    let status: ServerStatus;
    if (server.state === "running" || server.state === "starting") status = await callAgent(server.hostId, "server.restart", { serverId }, lifecycleTimeoutMs(server));
    else if (server.state === "stopped" || server.state === "crashed") status = await callAgent(server.hostId, "server.start", { serverId });
    else throw notStartable(server.state);
    await storeStatus(serverId, status);
    return await dtoOf(serverId);
  }

  /**
   * Re-provision with `reinstall: true` (also the retry after install_failed). 409 while running.
   */
  export async function reinstall(user: User, serverId: string): Promise<GameServerDto> {
    const server = await getAccessible(user, serverId);
    if (server.state === "deleting") throw deletingError();
    if (!SETTINGS_STATES.includes(server.state)) throw HttpError.conflict("Stop the server before reinstalling it.");
    const built = await specForRow(server);
    const status = await provision(server.hostId, built.spec, built.specHash, true);
    await GameServer.update({ specHash: built.specHash }, { where: { id: serverId } });
    await storeStatus(serverId, status);
    return await dtoOf(serverId);
  }

  /**
   * Turn the row into a `deleting` tombstone, then delete on the agent (409 when offline, unless it already is a
   * tombstone) and drop the row and its ports once the agent confirms.
   * @returns true when the delete finished; false when the host didn't answer in time and the tombstone stays (it is
   * retried every minute and after the host's next hello).
   */
  export async function remove(user: User, serverId: string, keepData: boolean): Promise<boolean> {
    const server = await getAccessible(user, serverId);
    if (server.state !== "deleting" && !AgentGateway.isOnline(server.hostId)) throw offlineError(server.host!);
    await markDeleting(server, keepData);
    return await finishDelete(server.id, server.hostId, keepData, lifecycleTimeoutMs(server), true);
  }

  /**
   * Store the tombstone: state `deleting` with the delete's keepData. Pushes the state.
   */
  async function markDeleting(server: GameServer, keepData: boolean): Promise<void> {
    server.state = "deleting";
    server.stateReason = null;
    server.stateChangedAt = new Date();
    server.deleteKeepData = keepData;
    await server.save();
    rememberProgress(server.id, null);
    pushState(server);
  }

  /**
   * Ask the agent to delete a tombstone's server and drop the row when it confirms (an agent that doesn't know the
   * server counts as confirmed). A failure leaves the tombstone and schedules a retry while the host is online.
   * @param rethrow Throw the agent's refusal (an HTTP delete); otherwise only log it (retries, reconcile).
   */
  async function finishDelete(serverId: string, hostId: string, keepData: boolean, timeoutMs: number, rethrow: boolean): Promise<boolean> {
    clearTimeout(_deleteRetries.get(serverId));
    _deleteRetries.delete(serverId);
    try {
      await callAgent(hostId, "server.delete", { serverId, keepData }, timeoutMs);
    } catch (error) {
      const missing = error instanceof HttpError && error.status === 404;
      if (!missing) {
        scheduleDeleteRetry(serverId);
        const message = (error as Error).message;
        await GameServer.update({ stateReason: `The host hasn't confirmed the delete yet: ${message}` }, { where: { id: serverId, state: "deleting" } });
        const pending = error instanceof HttpError && (error.status === 504 || error.status === 503 || error.status === 409);
        if (rethrow && !pending) throw error;
        if (!pending) console.warn(`delete of server ${serverId} on host ${hostId} failed: ${message}`);
        return false;
      }
    }
    const row = await GameServer.findByPk(serverId, { attributes: ["id", "ownerId", "state"] });
    if (!row || row.state !== "deleting") return true;
    await sequelize.transaction(async (transaction) => {
      await PortAllocation.destroy({ where: { serverId }, transaction });
      await GameServer.destroy({ where: { id: serverId, state: "deleting" }, transaction });
    });
    _progress.delete(serverId);
    _hostOf.delete(serverId);
    pushUpdated(row.ownerId, serverId);
    return true;
  }

  /**
   * Try a tombstone again in DELETE_RETRY_MS while its host is online (an offline host retries after hello).
   */
  function scheduleDeleteRetry(serverId: string): void {
    if (_deleteRetries.has(serverId)) return;
    _deleteRetries.set(serverId, setTimeout(async () => {
      _deleteRetries.delete(serverId);
      try {
        const row = await GameServer.findByPk(serverId, { include: [{ association: "definition" }] });
        if (!row || row.state !== "deleting" || !AgentGateway.isOnline(row.hostId)) return;
        await finishDelete(row.id, row.hostId, row.deleteKeepData, lifecycleTimeoutMs(row), false);
      } catch (error) {
        console.error(`delete retry of server ${serverId} failed`, error);
      }
    }, DELETE_RETRY_MS));
  }

  /**
   * Time the agent may need for a restart or a delete of this server: the definition's stop timeout, the agent's
   * `docker stop` grace, and a margin for the rest.
   */
  function lifecycleTimeoutMs(server: GameServer): number {
    const stopTimeout = server.definition?.document.stop?.timeout ?? DEFAULT_STOP_TIMEOUT_SEC;
    return (stopTimeout + AGENT_STOP_GRACE_SEC + LIFECYCLE_MARGIN_SEC) * 1000;
  }
  //#endregion

  //#region Console
  export async function input(user: User, serverId: string, line: string): Promise<void> {
    if (typeof line !== "string" || line.trim() === "") throw HttpError.badRequest("\"line\" must be the command to send.");
    if (line.length > MAX_INPUT_CHARS) throw HttpError.badRequest(`A console line can be at most ${MAX_INPUT_CHARS} characters long.`);
    if (/[\r\n]/.test(line)) throw HttpError.badRequest("Send one line at a time (no line breaks).");
    const server = await getAccessible(user, serverId);
    _inputLimiter.hit(serverId);
    if (server.state !== "running" && server.state !== "starting") throw HttpError.conflict("The server isn't running, so it can't take commands.");
    await callAgent(server.hostId, "server.input", { serverId, line });
  }

  /**
   * The newest `limit` lines, or with `beforeSeq` the page before that line. The agent cuts the answer at
   * CONSOLE_BATCH_MAX_BYTES; `more` says older lines exist.
   */
  export async function backlog(user: User, serverId: string, limit: number, beforeSeq: number): Promise<ConsoleBacklogResponse> {
    const server = await getAccessible(user, serverId);
    const empty: ConsoleBacklogResponse = { lines: [], more: false };
    if (!AgentGateway.isOnline(server.hostId)) return empty; // Nothing to show while the host is away.
    try {
      const page = await callAgent(server.hostId, "server.backlog", {
        serverId,
        limit: Math.min(CONSOLE_BACKLOG_MAX_LINES, limit),
        ...(beforeSeq > 0 ? { beforeSeq } : {}),
      });
      return { lines: sanitizeLines(page.lines ?? []), more: page.more === true };
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 409)) return empty;
      throw error;
    }
  }

  /**
   * Console lines from an agent, shape-checked: malformed lines are skipped and over-long text is cut to
   * CONSOLE_LINE_MAX_BYTES, so one bad line never costs the rest of its batch.
   */
  export function sanitizeLines(raw: unknown[]): ConsoleLine[] {
    const lines: ConsoleLine[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const line = item as Partial<ConsoleLine>;
      if (!Number.isSafeInteger(line.seq) || typeof line.at !== "string" || typeof line.text !== "string") continue;
      if (line.stream !== "output" && line.stream !== "input" && line.stream !== "system") continue;
      lines.push({ seq: line.seq!, at: line.at.slice(0, 40), stream: line.stream, text: truncateUtf8(line.text, CONSOLE_LINE_MAX_BYTES) });
    }
    return lines;
  }

  const _encoder = new TextEncoder();

  /**
   * Cut text to at most maxBytes of UTF-8 without splitting a character.
   */
  function truncateUtf8(text: string, maxBytes: number): string {
    if (text.length * 3 <= maxBytes || _encoder.encode(text).length <= maxBytes) return text;
    let bytes = 0;
    let end = 0;
    for (const char of text) {
      const size = char.codePointAt(0)! < 0x80 ? 1 : char.codePointAt(0)! < 0x800 ? 2 : char.codePointAt(0)! < 0x10000 ? 3 : 4;
      if (bytes + size > maxBytes - 3) break; // Room for the "…".
      bytes += size;
      end += char.length;
    }
    return text.slice(0, end) + "…";
  }
  //#endregion

  //#region From the agent
  /**
   * `server.state` event: store state/reason/exitCode/stateChangedAt (installedAt on install → stopped), push
   * `server.state`. Ignores servers not on this host.
   */
  export async function applyStateChange(hostId: string, change: StateChange): Promise<void> {
    const server = await GameServer.findOne({ where: { id: change.serverId, hostId } });
    if (!server) {
      console.warn(`host ${hostId} reported a state for the unknown server ${change.serverId}`);
      return;
    }
    if (server.state === "deleting") return; // A tombstone keeps its state until the agent confirms the delete.
    const at = parseDate(change.at) ?? new Date();
    server.state = change.state;
    server.stateReason = change.reason;
    if (change.exitCode !== null) server.lastExitCode = change.exitCode;
    server.stateChangedAt = at;
    if (change.state === "stopped" && change.previous === "installing") server.installedAt = at;
    await server.save();
    rememberProgress(server.id, change.installProgress);
    pushState(server);
  }

  /**
   * `server.console` event: push to the `server:<id>` topic. Nothing is stored.
   */
  export function forwardConsole(hostId: string, batch: ConsoleBatch): void {
    let lookup = _hostOf.get(batch.serverId);
    if (!lookup) {
      lookup = GameServer.findByPk(batch.serverId, { attributes: ["id", "hostId"] }).then((row) => row?.hostId ?? null);
      _hostOf.set(batch.serverId, lookup);
    }
    lookup.then((owner) => {
      if (owner === null) {
        _hostOf.delete(batch.serverId); // Not stored yet (a create in flight) or unknown: look again next time.
        return;
      }
      if (owner !== hostId) return;
      LiveGateway.push("server.console", { serverId: batch.serverId, lines: batch.lines }, { topic: `server:${batch.serverId}` });
    }).catch((error) => {
      _hostOf.delete(batch.serverId);
      console.error("console forward failed", error);
    });
  }

  /**
   * After `hello`: align rows with the agent's inventory. Known server → store its state; spec hash differs while
   * stopped → re-provision; row without agent state → provision; agent server unknown to the panel → log only (never
   * delete user data automatically).
   */
  export async function reconcile(hostId: string, servers: ServerStatus[]): Promise<void> {
    const rows = await GameServer.findAll({ where: { hostId }, include: FULL_INCLUDE });
    const reported = new Map(servers.map((status) => [status.serverId, status]));
    for (const row of rows) {
      if (_creating.has(row.id)) continue;
      try {
        await reconcileOne(row, reported.get(row.id));
      } catch (error) {
        console.error(`reconcile of server ${row.id} on host ${hostId} failed`, error);
      }
    }
    const known = new Set(rows.map((row) => row.id));
    for (const status of servers) {
      if (!known.has(status.serverId)) console.warn(`host ${hostId} manages the server ${status.serverId}, which the panel does not know. Left alone.`);
    }
  }

  async function reconcileOne(row: GameServer, status: ServerStatus | undefined): Promise<void> {
    if (row.state === "deleting") {
      // A tombstone: delete whatever the agent still has (an orphan container holding the port), never provision.
      await finishDelete(row.id, row.hostId, row.deleteKeepData, lifecycleTimeoutMs(row), false);
      return;
    }
    if (!status) {
      // The agent has no such server (create never reached it, or its data is gone): provision it again.
      await reprovision(row, row.installedAt === null);
      return;
    }
    rememberProgress(row.id, status.installProgress);
    const since = parseDate(status.since) ?? new Date();
    if (row.state !== status.state || row.stateReason !== status.reason) {
      row.state = status.state;
      row.stateReason = status.reason;
      if (status.exitCode !== null) row.lastExitCode = status.exitCode;
      row.stateChangedAt = since;
      await row.save();
      pushState(row);
    }
    if (row.specHash !== status.specHash && SETTINGS_STATES.includes(status.state)) await reprovision(row, false);
  }

  async function reprovision(row: GameServer, reinstall: boolean): Promise<void> {
    const built = await specForRow(row);
    const status = await provision(row.hostId, built.spec, built.specHash, reinstall);
    await GameServer.update({ specHash: built.specHash }, { where: { id: row.id } });
    await storeStatus(row.id, status);
  }
  //#endregion

  //#region Helpers
  interface SpecValues {
    id: string;
    name: string;
    variables: Record<string, Value>;
    limits: Limits;
    autostart: boolean;
    autoRestart: boolean;
  }

  /**
   * The spec for a server with these values: allocations → port bindings (internal ports use their declared default).
   */
  async function specFor(definition: Definition, values: SpecValues, allocations: PortAllocation[]): Promise<{ spec: ServerSpec; specHash: string }> {
    const ports: PortBinding[] = (definition.document.ports ?? []).map((decl) => {
      if (decl.internal) return { name: decl.name, proto: decl.proto, port: decl.default!, internal: true };
      const allocation = allocations.find((row) => row.name === decl.name);
      if (!allocation) throw new Error(`The server has no allocated port "${decl.name}".`);
      return { name: decl.name, proto: decl.proto, port: allocation.port, internal: false };
    });
    try {
      return await DefinitionEngine.buildSpec({
        serverId: values.id,
        serverName: values.name,
        definition: definition.document,
        files: definition.files,
        source: definition.source?.name ?? "",
        commit: definition.commit,
        variables: values.variables,
        ports,
        limits: values.limits,
        autostart: values.autostart,
        autoRestart: values.autoRestart,
        imageRegistry: Config.IMAGE_REGISTRY,
      });
    } catch (error) {
      throw HttpError.badRequest(`The definition can't be rendered with these values: ${(error as Error).message}`);
    }
  }

  async function specForRow(server: GameServer): Promise<{ spec: ServerSpec; specHash: string }> {
    return await specFor(server.definition!, {
      id: server.id,
      name: server.name,
      variables: server.variables,
      limits: { memoryMb: server.memoryMb, cpuMillis: server.cpuMillis, pids: DEFAULT_LIMITS.pids, diskMb: server.diskMb },
      autostart: server.autostart,
      autoRestart: server.autoRestart,
    }, server.ports!);
  }

  async function provision(hostId: string, spec: ServerSpec, specHash: string, reinstall: boolean): Promise<ServerStatus> {
    return await callAgent(hostId, "server.provision", { spec, specHash, reinstall }, PROVISION_TIMEOUT_MS);
  }

  /**
   * `AgentGateway.request` with the agent's refusals turned into HTTP errors (the host being offline already is one).
   */
  async function callAgent<T extends keyof PanelToAgentRequests>(
    hostId: string,
    type: T,
    data: PanelToAgentRequests[T]["request"],
    timeoutMs?: number,
  ): Promise<PanelToAgentRequests[T]["response"]> {
    try {
      return await AgentGateway.request(hostId, type, data, timeoutMs);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = (error as { code?: string }).code;
      const message = (error as Error).message;
      if (code === "conflict") throw HttpError.conflict(message);
      if (code === "not_found") throw HttpError.notFound(message);
      if (code === "timeout") throw new HttpError(504, "The host didn't answer in time. Check the server's state and try again.");
      if (code === "unsupported" && !AgentGateway.isOnline(hostId)) throw new HttpError(503, `The host disconnected before it answered (${message}). Check the server's state once it is back.`);
      if (code === "unsupported") throw new HttpError(501, `The host's agent can't do that yet: ${message}`);
      throw new HttpError(502, `The host refused: ${message}`);
    }
  }

  /**
   * Take back a create that failed: the row becomes a `deleting` tombstone (ports still held) until the agent
   * confirms it removed whatever it may have started, now or after a retry or the host's next hello.
   */
  async function rollbackCreate(serverId: string): Promise<void> {
    try {
      const row = await GameServer.findByPk(serverId, { include: [{ association: "definition" }] });
      if (!row) return;
      await markDeleting(row, false);
      const finished = await finishDelete(row.id, row.hostId, false, lifecycleTimeoutMs(row), false);
      if (!finished) console.warn(`server ${serverId}: the rolled-back create stays as a tombstone until its host confirms the delete`);
    } catch (error) {
      console.error(`could not roll back the server ${serverId}`, error);
    }
  }

  /**
   * Store the state the agent answered with, unless a newer event already moved the row on.
   */
  async function storeStatus(serverId: string, status: ServerStatus): Promise<void> {
    rememberProgress(serverId, status.installProgress);
    const row = await GameServer.findByPk(serverId);
    if (!row) return;
    const since = parseDate(status.since) ?? new Date();
    if (row.state === status.state && row.stateReason === status.reason) return;
    const [changed] = await GameServer.update(
      { state: status.state, stateReason: status.reason, stateChangedAt: since, ...(status.exitCode !== null ? { lastExitCode: status.exitCode } : {}) },
      { where: { id: serverId, state: { [Op.ne]: "deleting" }, [Op.or]: [{ state: "creating" }, { stateChangedAt: { [Op.lte]: since } }] } },
    );
    if (changed > 0) pushState((await GameServer.findByPk(serverId))!);
  }

  function rememberProgress(serverId: string, progress: InstallProgress | null): void {
    if (progress) _progress.set(serverId, progress);
    else _progress.delete(serverId);
  }

  function pushState(server: GameServer): void {
    LiveGateway.push("server.state", {
      serverId: server.id,
      state: server.state,
      exitCode: server.lastExitCode,
      reason: server.stateReason,
      installProgress: _progress.get(server.id) ?? null,
      at: server.stateChangedAt.toISOString(),
    }, audience(server.ownerId));
  }

  function pushUpdated(ownerId: number, serverId: string): void {
    LiveGateway.push("server.updated", { serverId }, audience(ownerId));
  }

  function audience(ownerId: number): LiveGateway.Audience {
    return { permission: "SERVERS_MANAGE_ALL", userIds: [ownerId] };
  }

  async function dtoOf(serverId: string): Promise<GameServerDto> {
    const server = await GameServer.findByPk(serverId, { include: LIST_INCLUDE });
    if (!server) throw HttpError.notFound("There is no game server with that id.");
    return toDto(server);
  }

  function toDto(server: GameServer): GameServerDto {
    const host = server.host!;
    const ports = [...server.ports!].sort((a, b) => a.id - b.id);
    const main = ports.find((port) => port.name === "game") ?? ports[0];
    const address = host.address ?? host.facts?.hostname ?? null;
    return {
      id: server.id,
      name: server.name,
      owner: { id: server.owner!.id, username: server.owner!.username },
      host: { id: host.id, name: host.name, online: AgentGateway.isOnline(host.id) },
      definition: { id: server.definitionId, gameId: server.definition!.gameId, name: server.definition!.name, commit: server.definition!.commit },
      state: server.state,
      stateReason: server.stateReason,
      lastExitCode: server.lastExitCode,
      stateChangedAt: server.stateChangedAt.toISOString(),
      installProgress: server.state === "installing" ? _progress.get(server.id) ?? null : null,
      ports: ports.map((port) => ({ name: port.name, proto: port.proto, port: port.port, pinned: port.pinned })),
      address: main && address ? `${address}:${main.port}` : null,
      limits: { memoryMb: server.memoryMb, cpuMillis: server.cpuMillis, diskMb: server.diskMb },
      autostart: server.autostart,
      autoRestart: server.autoRestart,
      createdAt: server.createdAt.toISOString(),
    };
  }

  async function toDetail(user: User, server: GameServer): Promise<GameServerDetailResponse> {
    const isAdmin = user.isAdmin();
    const variables: ServerVariableDto[] = (server.definition!.document.variables ?? [])
      .filter((decl) => isAdmin || !decl.admin_only)
      .map((decl) => {
        const value = server.variables[decl.key] ?? null;
        return {
          key: decl.key,
          label: decl.label ?? decl.key,
          description: decl.description ?? null,
          type: decl.type,
          options: decl.options ?? null,
          unit: decl.unit ?? null,
          min: decl.min ?? null,
          max: decl.max ?? null,
          reinstall: decl.reinstall ?? false,
          adminOnly: decl.admin_only ?? false,
          value: decl.type === "secret" ? null : value,
          isSet: value !== null && value !== "",
        };
      });
    const newer = await Definition.count({
      where: { sourceId: server.definition!.sourceId, gameId: server.definition!.gameId, active: true, id: { [Op.ne]: server.definitionId } },
    });
    return { ...toDto(server), variables, updateAvailable: newer > 0 };
  }

  async function mayUseHost(user: User, hostId: string): Promise<boolean> {
    if (user.hasPermission("SERVERS_MANAGE_ALL")) return true;
    return await HostGrant.count({ where: { hostId, userId: user.id } }) > 0;
  }

  /**
   * Refuse limits that don't fit the host next to its other servers.
   * @param excludeId A server being changed: its own limits don't count.
   * @throws HttpError 409 naming the resource.
   */
  async function assertHostCapacity(host: Host, limits: Limits, excludeId: string | null, transaction?: Transaction): Promise<void> {
    const others = await GameServer.findAll({
      where: { hostId: host.id, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) },
      attributes: ["memoryMb", "cpuMillis", "diskMb"],
      transaction,
    });
    const used = {
      memoryMb: others.reduce((sum, row) => sum + row.memoryMb, 0),
      cpuMillis: others.reduce((sum, row) => sum + row.cpuMillis, 0),
      diskMb: others.reduce((sum, row) => sum + row.diskMb, 0),
    };
    const facts = host.facts;
    const capacity = {
      memoryMb: host.maxMemoryMb ?? (facts ? Math.max(0, Math.floor(facts.memory.totalBytes / 1048576) - MEMORY_RESERVE_MB) : null),
      cpuMillis: host.maxCpuMillis ?? (facts ? facts.cpu.threads * 1000 : null),
      diskMb: host.maxDiskMb ?? (facts ? Math.floor(facts.disk.totalBytes / 1048576) : null),
    };
    const checks: [keyof typeof used, string, string][] = [["memoryMb", "memory", "MB"], ["cpuMillis", "CPU", "thousandths of a CPU"], ["diskMb", "disk space", "MB"]];
    for (const [key, label, unit] of checks) {
      const max = capacity[key];
      if (max !== null && used[key] + limits[key] > max) {
        throw HttpError.conflict(`${host.name} doesn't have enough ${label} left: this server needs ${limits[key]} ${unit}, ${Math.max(0, max - used[key])} of ${max} ${unit} are free.`);
      }
    }
  }

  function deletingError(): HttpError {
    return HttpError.conflict("The server is being deleted.");
  }

  function offlineError(host: Host): HttpError {
    return HttpError.conflict(`The host "${host.name}" is offline. Check that gss-agent is running on it.`);
  }

  function notStartable(state: ServerState): HttpError {
    switch (state) {
      case "running":
      case "starting":
        return HttpError.conflict("The server is already running.");
      case "stopping":
        return HttpError.conflict("The server is still stopping.");
      case "install_failed":
        return HttpError.conflict("The install failed. Reinstall the server first.");
      case "deleting":
        return deletingError();
      default:
        return HttpError.conflict("The server is still installing.");
    }
  }

  function parseName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (name === "" || name.length > LIMITS.SERVER_NAME_MAX) throw HttpError.badRequest(`The server name must be 1-${LIMITS.SERVER_NAME_MAX} characters long.`);
    // `{{server.name}}` can reach config files and commands, like variable strings: no line breaks or control characters.
    // deno-lint-ignore no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) throw HttpError.badRequest("The server name can't contain line breaks or control characters.");
    return name;
  }

  function parseFlag(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw HttpError.badRequest(`"${field}" must be true or false.`);
    return value;
  }

  function parseVariables(value: unknown): Record<string, Value> {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw HttpError.badRequest("\"variables\" must be an object of variable key to value.");
    return value as Record<string, Value>;
  }

  function parseDate(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  //#endregion
}

export default GameServerService;
