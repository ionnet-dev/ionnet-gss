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
 *
 * Mutating operations on one server take turns (`withLock`): create's provision, update, upgrade, start, restart,
 * reinstall, updateGame, delete, reconcile and delete retries. Stop doesn't wait for the lock: it is how a start that
 * waits for a stack's services, or an install, is cancelled, and the agent orders requests per server itself.
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
  UpgradeServerBody,
  UpgradeServerResponse,
} from "@shared/api/servers.ts";
import type { GameDefinition, PortDecl, PortInUse, ServicesChange, ServiceStatus, VariableDecl } from "@shared/protocol/protocol.gen.ts";
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
import { OptionsFetcher } from "../definitions/OptionsFetcher.ts";
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
  /**
   * What the agent waits for a service with a healthcheck but no `startTimeout` (`stacks.DefaultStartTimeout`), and the
   * margin a stack's start gets on top of its longest service wait.
   */
  const DEFAULT_SERVICE_START_TIMEOUT_SEC = 120;
  const START_MARGIN_SEC = 30;
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
  /**
   * The spec hash each server had on its agent at the agent's last answer (hello, provision, start…). A row whose hash
   * differs while stopped (an upgrade that failed half-way) is provisioned again before it starts.
   */
  const _agentSpecHash = new Map<string, string>();
  /**
   * Per-server lock: the tail of each server's chain of mutating operations.
   */
  const _locks = new Map<string, Promise<void>>();

  /**
   * `HttpError` 409 for an agent's `port_in_use`, keeping the port so create and upgrade can allocate around it.
   */
  class PortInUseError extends HttpError {
    constructor(message: string, public readonly port: PortInUse) {
      super(409, message);
      this.name = "PortInUseError";
    }
  }

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
    const allowPrivateNetwork = parsePrivateNetwork(user, body.allowPrivateNetwork) ?? false;
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
    if (!definition.active || definition.source?.enabled === false) throw HttpError.conflict("That version of the game definition is no longer offered. Reload the page to pick the current one.");

    const decls = definition.document.variables ?? [];
    const { values } = DefinitionEngine.resolveVariables(decls, variables, null, user.isAdmin());
    await checkDynamicOptions(decls, values, Object.keys(variables), user.isAdmin());
    const limits = DefinitionEngine.resolveLimits(decls, values, DEFAULT_LIMITS);
    const services = serviceTotals(definition.document);
    await Quota.assertFits(user.id, { servers: 1, memoryMb: limits.memoryMb + services.memoryMb, cpuMillis: limits.cpuMillis + services.cpuMillis, diskMb: limits.diskMb });

    const id = crypto.randomUUID();
    const built = await sequelize.transaction(async (transaction) => {
      const locked = await Host.findByPk(host.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw HttpError.notFound("There is no host with that id.");
      await assertHostCapacity(locked, limits, null, definition.document, transaction);
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
        allowPrivateNetwork,
        specHash: null,
        installedAt: null,
      }, { transaction });
      const allocations = await PortAllocation.allocate(locked, id, definition.document.ports ?? [], transaction, pinned);
      const built = await specFor(definition, { id, name, variables: values, limits, autostart, autoRestart, allowPrivateNetwork }, allocations);
      row.specHash = built.specHash;
      await row.save({ transaction });
      return built;
    });

    _creating.add(id);
    try {
      await withLock(id, async () => {
        try {
          let status: ServerStatus;
          try {
            status = await provision(host.id, built.spec, built.specHash, true);
          } catch (error) {
            // Something outside the panel holds the port: allocate another one and try once more.
            const moved = error instanceof PortInUseError ? await replacePort(host.id, id, definition.document.ports ?? [], error.port, null) : null;
            if (!moved) throw error;
            const retry = await specFor(definition, { id, name, variables: values, limits, autostart, autoRestart, allowPrivateNetwork }, moved);
            await GameServer.update({ specHash: retry.specHash }, { where: { id } });
            status = await provision(host.id, retry.spec, retry.specHash, true);
          }
          await storeStatus(id, status);
        } catch (error) {
          await rollbackCreate(id);
          throw error;
        }
      });
    } finally {
      _creating.delete(id);
    }
    pushUpdated(user.id, id);
    return await detail(user, id);
  }

  /**
   * Name, variables, autostart, autoRestart, allowPrivateNetwork (SERVERS_PRIVATE_NETWORK). 409 unless stopped /
   * install_failed / crashed. Re-provisions with the new spec (reinstall when a `reinstall` variable changed).
   */
  export async function update(user: User, serverId: string, body: UpdateServerBody): Promise<UpdateServerResponse> {
    return await withLock(serverId, () => updateLocked(user, serverId, body));
  }

  async function updateLocked(user: User, serverId: string, body: UpdateServerBody): Promise<UpdateServerResponse> {
    const server = await getAccessible(user, serverId);
    if (server.state === "deleting") throw deletingError();
    if (!SETTINGS_STATES.includes(server.state)) {
      throw HttpError.conflict("Stop the server before changing its settings. They apply at the next start.");
    }
    const name = body.name === undefined ? server.name : parseName(body.name);
    const autostart = parseFlag(body.autostart, "autostart") ?? server.autostart;
    const autoRestart = parseFlag(body.autoRestart, "autoRestart") ?? server.autoRestart;
    const allowPrivateNetwork = parsePrivateNetwork(user, body.allowPrivateNetwork) ?? server.allowPrivateNetwork;
    const submitted = parseVariables(body.variables);
    const definition = server.definition!;
    const decls = definition.document.variables ?? [];
    const { values, reinstall } = DefinitionEngine.resolveVariables(decls, submitted, server.variables, user.isAdmin());
    await checkDynamicOptions(decls, values, Object.keys(submitted), user.isAdmin());
    const limits = DefinitionEngine.resolveLimits(decls, values, DEFAULT_LIMITS);

    const grown = {
      servers: 0,
      memoryMb: Math.max(0, limits.memoryMb - server.memoryMb),
      cpuMillis: Math.max(0, limits.cpuMillis - server.cpuMillis),
      diskMb: Math.max(0, limits.diskMb - server.diskMb),
    };
    if (grown.memoryMb || grown.cpuMillis || grown.diskMb) {
      await Quota.assertFits(server.ownerId, grown);
      await assertHostCapacity(server.host!, limits, server.id, definition.document);
    }

    const built = await specFor(definition, { id: server.id, name, variables: values, limits, autostart, autoRestart, allowPrivateNetwork }, server.ports!);
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
      allowPrivateNetwork,
      specHash: built.specHash,
    }, { where: { id: server.id } });
    pushUpdated(server.ownerId, server.id);
    return { server: await detail(user, server.id), reinstallPending: reinstall };
  }

  export async function start(user: User, serverId: string): Promise<GameServerDto> {
    return await withLock(serverId, async () => {
      const server = await getAccessible(user, serverId);
      if (server.state !== "stopped" && server.state !== "crashed") throw notStartable(server.state);
      await startOnAgent(server);
      return await dtoOf(serverId);
    });
  }

  /**
   * `server.start`, after provisioning the row's spec when the agent has another one (an upgrade that failed after
   * the agent took the new spec). Waits long enough for a stack's services.
   */
  async function startOnAgent(server: GameServer): Promise<void> {
    const agentHash = _agentSpecHash.get(server.id);
    if (agentHash !== undefined && agentHash !== server.specHash) await reprovision(server, false);
    const status = await callAgent(server.hostId, "server.start", { serverId: server.id }, startTimeoutMs(server.definition!.document));
    await storeStatus(server.id, status);
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
    return await withLock(serverId, async () => {
      const server = await getAccessible(user, serverId);
      if (server.state === "running" || server.state === "starting") {
        const timeoutMs = lifecycleTimeoutMs(server) + (startTimeoutMs(server.definition!.document) ?? 0);
        await storeStatus(serverId, await callAgent(server.hostId, "server.restart", { serverId }, timeoutMs));
      }
      else if (server.state === "stopped" || server.state === "crashed") {
        await startOnAgent(server);
      }
      else {
        throw notStartable(server.state);
      }
      return await dtoOf(serverId);
    });
  }

  /**
   * Move a stopped server to another (normally the latest active) version of its definition (M3): see
   * `UpgradeServerBody`. Re-allocates ports when the port declarations changed; refuses (409) when quota or host
   * capacity no longer fit.
   */
  export async function upgrade(user: User, serverId: string, body: Partial<UpgradeServerBody>): Promise<UpgradeServerResponse> {
    return await withLock(serverId, () => upgradeLocked(user, serverId, body));
  }

  async function upgradeLocked(user: User, serverId: string, body: Partial<UpgradeServerBody>): Promise<UpgradeServerResponse> {
    const server = await getAccessible(user, serverId);
    if (server.state === "deleting") throw deletingError();
    if (!SETTINGS_STATES.includes(server.state)) throw HttpError.conflict("Stop the server before upgrading it. The new version applies at the next start.");
    const current = server.definition!;

    let target: Definition | null;
    if (body.definitionId !== undefined) {
      if (!Number.isInteger(body.definitionId)) throw HttpError.badRequest("\"definitionId\" must be the id of a game definition version.");
      target = await Definition.findByPk(body.definitionId, { include: [{ association: "source" }] });
      if (!target || target.sourceId !== current.sourceId || target.gameId !== current.gameId) {
        throw HttpError.notFound("That isn't a version of this server's game from its source.");
      }
    }
    else {
      target = await Definition.findOne({ where: { sourceId: current.sourceId, gameId: current.gameId, active: true }, include: [{ association: "source" }] });
      if (!target) throw HttpError.conflict("The source no longer offers this game, so there is no version to upgrade to.");
    }
    if (target.id === current.id) throw HttpError.conflict("The server already uses the newest version of its game.");
    if (target.source?.enabled === false) throw HttpError.conflict("The source of this game is switched off.");

    // Re-resolve against the new declarations: kept values must still be valid, new keys get defaults or generated
    // secrets, and `body.variables` replaces kept values (for one the new version rejects).
    const decls = target.document.variables ?? [];
    const replacements = checkReplacements(user, decls, body.variables);
    const kept: Record<string, Value> = {};
    for (const decl of decls) if (Object.hasOwn(server.variables, decl.key)) kept[decl.key] = server.variables[decl.key];
    const submitted = { ...kept, ...replacements };
    let resolved: { values: Record<string, Value>; reinstall: boolean };
    try {
      resolved = DefinitionEngine.resolveVariables(decls, submitted, server.variables, true);
      await checkDynamicOptions(decls, resolved.values, Object.keys(submitted), user.isAdmin());
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        throw HttpError.badRequest(`The new version doesn't accept one of this server's settings: ${error.message} Send a new value for it with the upgrade.`);
      }
      throw error;
    }
    const values = resolved.values;
    const limits = DefinitionEngine.resolveLimits(decls, values, { memoryMb: server.memoryMb, cpuMillis: server.cpuMillis, pids: DEFAULT_LIMITS.pids, diskMb: server.diskMb });

    const before = serviceTotals(current.document);
    const after = serviceTotals(target.document);
    const grown = {
      servers: 0,
      memoryMb: Math.max(0, limits.memoryMb + after.memoryMb - (server.memoryMb + before.memoryMb)),
      cpuMillis: Math.max(0, limits.cpuMillis + after.cpuMillis - (server.cpuMillis + before.cpuMillis)),
      diskMb: Math.max(0, limits.diskMb - server.diskMb),
    };
    if (grown.memoryMb || grown.cpuMillis || grown.diskMb) {
      await Quota.assertFits(server.ownerId, grown);
      await assertHostCapacity(server.host!, limits, server.id, target.document);
    }

    // Did the install change? Compare what the agent would run: the rendered steps and the hook files they call.
    let oldPrint: string | null = null;
    try {
      oldPrint = installFingerprint((await specForRow(server)).spec);
    } catch {
      // The running version can't be rendered any more: treat the install as changed.
    }
    const probe = await specFor(target, { id: server.id, name: server.name, variables: values, limits, autostart: server.autostart, autoRestart: server.autoRestart, allowPrivateNetwork: server.allowPrivateNetwork }, await portsFor(target, server));
    const installChanged = oldPrint === null || oldPrint !== installFingerprint(probe.spec);
    const reinstall = installChanged || resolved.reinstall || decls.some((decl) => decl.reinstall && !Object.hasOwn(server.variables, decl.key));

    // Ports: keep what still matches and allocate what is new. Dropped ports stay held until the agent has the new
    // spec, and new ones until the old spec is back after a failure: while either spec may be live on the host, no
    // port of it goes to another server.
    const changedPorts = portChanges(target.document, server.ports!);
    let created: PortAllocation[] = [];
    if (changedPorts.add.length) {
      created = await sequelize.transaction(async (transaction) => {
        const host = await Host.findByPk(server.hostId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!host) throw HttpError.notFound("The server's host no longer exists.");
        return await PortAllocation.allocate(host, server.id, changedPorts.add, transaction);
      });
    }
    const specValues: SpecValues = { id: server.id, name: server.name, variables: values, limits, autostart: server.autostart, autoRestart: server.autoRestart, allowPrivateNetwork: server.allowPrivateNetwork };
    let sent = false;
    try {
      let built = await specFor(target, specValues, [...changedPorts.keep, ...created]);
      let status: ServerStatus;
      sent = true;
      try {
        status = await provision(server.hostId, built.spec, built.specHash, reinstall);
      } catch (error) {
        // Something outside the panel holds a port this upgrade allocated: allocate another one and try once more.
        const moved = error instanceof PortInUseError ? await replacePort(server.hostId, server.id, target.document.ports ?? [], error.port, created.map((row) => row.id)) : null;
        if (!moved) throw error;
        const oldIds = new Set(server.ports!.map((row) => row.id));
        built = await specFor(target, specValues, [...changedPorts.keep, ...moved.filter((row) => !oldIds.has(row.id))]);
        status = await provision(server.hostId, built.spec, built.specHash, reinstall);
      }
      await sequelize.transaction(async (transaction) => {
        if (changedPorts.drop.length) await PortAllocation.destroy({ where: { id: changedPorts.drop.map((row) => row.id) }, transaction });
        await GameServer.update({
          definitionId: target.id,
          variables: values,
          memoryMb: limits.memoryMb,
          cpuMillis: limits.cpuMillis,
          diskMb: limits.diskMb,
          specHash: built.specHash,
        }, { where: { id: server.id }, transaction });
      });
      await storeStatus(server.id, status);
    } catch (error) {
      await rollbackUpgrade(server, sent);
      throw error;
    }
    pushUpdated(server.ownerId, server.id);
    return { server: await detail(user, server.id), reinstall };
  }

  /**
   * `server.update` on the agent (M3): steamcmd steps + update hook. 409 unless stopped or crashed, or install_failed
   * after an earlier successful install (retrying a failed update); 400 when the game has neither.
   */
  export async function updateGame(user: User, serverId: string): Promise<GameServerDto> {
    return await withLock(serverId, () => updateGameLocked(user, serverId));
  }

  async function updateGameLocked(user: User, serverId: string): Promise<GameServerDto> {
    const server = await getAccessible(user, serverId);
    if (server.state === "deleting") throw deletingError();
    if (!canUpdateGame(server.definition!.document)) {
      throw HttpError.badRequest("This game has nothing to update: its definition has no steamcmd step and no update hook.");
    }
    if (server.state === "install_failed" && server.installedAt === null) {
      throw HttpError.conflict("The game was never installed on this server. Reinstall it instead of updating.");
    }
    if (!SETTINGS_STATES.includes(server.state)) throw HttpError.conflict("Stop the server before updating the game.");
    const status = await callAgent(server.hostId, "server.update", { serverId }, PROVISION_TIMEOUT_MS);
    await storeStatus(serverId, status);
    return await dtoOf(serverId);
  }

  /**
   * `server.services` event (M3): store `servicesStatus`, push `server.services`.
   */
  export async function applyServicesChange(hostId: string, change: ServicesChange): Promise<void> {
    const server = await GameServer.findOne({ where: { id: change.serverId, hostId }, attributes: ["id", "ownerId", "state", "servicesStatus"] });
    if (!server) {
      console.warn(`host ${hostId} reported services for the unknown server ${change.serverId}`);
      return;
    }
    if (server.state === "deleting") return;
    await storeServices(server, change.services);
  }

  /**
   * Re-provision with `reinstall: true` (also the retry after install_failed). 409 while running.
   */
  export async function reinstall(user: User, serverId: string): Promise<GameServerDto> {
    return await withLock(serverId, async () => {
      const server = await getAccessible(user, serverId);
      if (server.state === "deleting") throw deletingError();
      if (!SETTINGS_STATES.includes(server.state)) throw HttpError.conflict("Stop the server before reinstalling it.");
      await reprovision(server, true);
      return await dtoOf(serverId);
    });
  }

  /**
   * Turn the row into a `deleting` tombstone, then delete on the agent (409 when offline, unless it already is a
   * tombstone) and drop the row and its ports once the agent confirms.
   * @returns true when the delete finished; false when the host didn't answer in time and the tombstone stays (it is
   * retried every minute and after the host's next hello).
   */
  export async function remove(user: User, serverId: string, keepData: boolean): Promise<boolean> {
    return await withLock(serverId, async () => {
      const server = await getAccessible(user, serverId);
      if (server.state !== "deleting" && !AgentGateway.isOnline(server.hostId)) throw offlineError(server.host!);
      await markDeleting(server, keepData);
      return await finishDelete(server.id, server.hostId, keepData, lifecycleTimeoutMs(server), true);
    });
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
    _agentSpecHash.delete(serverId);
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
        await withLock(serverId, async () => {
          const row = await GameServer.findByPk(serverId, { include: [{ association: "definition" }] });
          if (!row || row.state !== "deleting" || !AgentGateway.isOnline(row.hostId)) return;
          await finishDelete(row.id, row.hostId, row.deleteKeepData, lifecycleTimeoutMs(row), false);
        });
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

  /**
   * Time the agent may need for a start: a stack waits for its services to be healthy (every service against one
   * deadline, so the longest `startTimeout` counts) before the game starts. undefined = the default request timeout.
   */
  function startTimeoutMs(document: GameDefinition): number | undefined {
    const waits = Object.values(document.services ?? {}).map((service) => service.healthcheck ? service.healthcheck.startTimeout ?? DEFAULT_SERVICE_START_TIMEOUT_SEC : 0);
    if (waits.length === 0) return undefined;
    return Math.max(Config.AGENT_REQUEST_TIMEOUT_SEC * 1000, (Math.max(...waits) + START_MARGIN_SEC) * 1000);
  }

  /**
   * Run `task` once every earlier mutating operation on the server has finished, so two of them never interleave
   * (a double-submitted upgrade allocating twice, an update overwriting a concurrent upgrade).
   */
  async function withLock<T>(serverId: string, task: () => Promise<T>): Promise<T> {
    const previous = _locks.get(serverId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => release = resolve);
    const tail = previous.then(() => done);
    _locks.set(serverId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (_locks.get(serverId) === tail) _locks.delete(serverId);
    }
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
      // A server with an operation in flight is settled by that operation (and by the next start or hello).
      if (_creating.has(row.id) || _locks.has(row.id)) continue;
      try {
        await withLock(row.id, () => reconcileOne(row, reported.get(row.id)));
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
    _agentSpecHash.set(row.id, status.specHash);
    const since = parseDate(status.since) ?? new Date();
    if (row.state !== status.state || row.stateReason !== status.reason) {
      row.state = status.state;
      row.stateReason = status.reason;
      if (status.exitCode !== null) row.lastExitCode = status.exitCode;
      row.stateChangedAt = since;
      await row.save();
      pushState(row);
    }
    if (status.services !== undefined) await storeServices(row, status.services);
    if (row.specHash !== status.specHash && SETTINGS_STATES.includes(status.state)) await reprovision(row, false);
    else if (row.specHash === status.specHash) await pruneStrayPorts(row.id);
  }

  /**
   * Provision the row's own spec (and free ports a failed upgrade left behind once the agent has it).
   */
  async function reprovision(row: GameServer, reinstall: boolean): Promise<void> {
    const built = await specForRow(row);
    const status = await provision(row.hostId, built.spec, built.specHash, reinstall);
    await GameServer.update({ specHash: built.specHash }, { where: { id: row.id } });
    row.specHash = built.specHash;
    await storeStatus(row.id, status);
    await pruneStrayPorts(row.id);
  }
  //#endregion

  //#region Helpers
  /**
   * Keep the stack's service states on the row and tell the owner when they changed (a missing list counts as empty).
   */
  async function storeServices(server: GameServer, services: ServiceStatus[]): Promise<void> {
    if (JSON.stringify(server.servicesStatus ?? []) === JSON.stringify(services)) return;
    await GameServer.update({ servicesStatus: services }, { where: { id: server.id } });
    server.servicesStatus = services;
    LiveGateway.push("server.services", { serverId: server.id, services }, audience(server.ownerId));
  }

  /**
   * The memory and CPU a definition's services add on top of the game container's limits.
   */
  function serviceTotals(document: GameDefinition): { memoryMb: number; cpuMillis: number } {
    let memoryMb = 0;
    let cpuMillis = 0;
    for (const service of Object.values(document.services ?? {})) {
      memoryMb += service.limits?.memoryMb ?? DefinitionEngine.DEFAULT_SERVICE_LIMITS.memoryMb;
      cpuMillis += service.limits?.cpuMillis ?? DefinitionEngine.DEFAULT_SERVICE_LIMITS.cpuMillis;
    }
    return { memoryMb, cpuMillis };
  }

  /**
   * The `variables` of an upgrade body: an object of known keys, admin-only ones only for admins.
   * @throws HttpError 400 for a malformed body or an unknown key, 403 for an admin-only key.
   */
  function checkReplacements(user: User, decls: VariableDecl[], variables: unknown): Record<string, Value> {
    if (variables === undefined) return {};
    if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
      throw HttpError.badRequest("\"variables\" must be an object of variable keys and values.");
    }
    const byKey = new Map(decls.map((decl) => [decl.key, decl]));
    for (const key of Object.keys(variables)) {
      const decl = byKey.get(key);
      if (!decl) throw HttpError.badRequest(`The new version has no variable "${key}". It has: ${decls.map((d) => d.key).join(", ") || "no variables"}.`);
      if (decl.admin_only && !user.isAdmin()) throw HttpError.forbidden(`Only administrators can change "${decl.label ?? key}".`);
    }
    return variables as Record<string, Value>;
  }

  function canUpdateGame(document: GameDefinition): boolean {
    return (document.install ?? []).some((step) => step.steamcmd !== undefined) || document.hooks?.update !== undefined;
  }

  /**
   * Checked-in `select` values that come from a fetched list. Only the keys the caller sent are looked at, so a stored
   * value that has since left the list doesn't block unrelated changes.
   * @throws HttpError 400 naming the variable.
   */
  async function checkDynamicOptions(decls: GameDefinition["variables"], values: Record<string, Value>, keys: string[], detailed: boolean): Promise<void> {
    for (const decl of decls ?? []) {
      if (!decl.options_from || !keys.includes(decl.key)) continue;
      const value = values[decl.key];
      if (typeof value !== "string" || await OptionsFetcher.isAllowed(decl, value)) continue;
      const list = await OptionsFetcher.getOptions(decl);
      const cause = list.error === null ? "" : detailed ? `the list couldn't be loaded: ${list.error}` : "the list couldn't be loaded right now";
      const hint = cause !== "" && decl.pattern !== undefined ? ` (${cause}; it must match ${decl.pattern})` : cause !== "" ? ` (${cause})` : "";
      throw HttpError.badRequest(`"${decl.label ?? decl.key}" (${decl.key}) must be one of the offered values${hint}.`);
    }
  }

  /**
   * What decides whether an upgrade must reinstall: the rendered install steps and the hook files they run.
   */
  function installFingerprint(spec: ServerSpec): string {
    const hooks = new Set(spec.init.install.flatMap((step) => step.hook !== undefined ? [step.hook] : []));
    return DefinitionEngine.canonicalJson({ install: spec.init.install, files: spec.files.filter((file) => hooks.has(file.path)) });
  }

  /**
   * The published ports a definition declares, split against the server's allocations: keep (same name and protocol),
   * drop (gone or changed protocol) and add (new).
   */
  function portChanges(document: GameDefinition, allocations: PortAllocation[]): { keep: PortAllocation[]; drop: PortAllocation[]; add: NonNullable<GameDefinition["ports"]> } {
    const wanted = (document.ports ?? []).filter((port) => !port.internal);
    const keep = allocations.filter((row) => wanted.some((port) => port.name === row.name && port.proto === row.proto));
    return {
      keep,
      drop: allocations.filter((row) => !keep.includes(row)),
      add: wanted.filter((port) => !keep.some((row) => row.name === port.name)),
    };
  }

  /**
   * Allocations the server would have under another definition, without touching the database (for the install check):
   * kept rows as they are, new ports as placeholders that only carry a number to render.
   */
  async function portsFor(target: Definition, server: GameServer): Promise<PortAllocation[]> {
    const changes = portChanges(target.document, server.ports!);
    const placeholders = changes.add.map((port) => ({ name: port.name, proto: port.proto, port: port.default ?? 0 }) as PortAllocation);
    return [...changes.keep, ...placeholders];
  }

  /**
   * Undo a failed upgrade, best effort. The row still has the old definition, values and ports (dropped ones were
   * never freed). Once the agent has the old spec again, the ports the upgrade allocated are freed. When that
   * provision fails too, both sets stay held: `start` and the next hello's reconcile see the agent's other spec hash,
   * provision the row's spec and free them then.
   * @param sent The new spec may have reached the agent; false = nothing to undo there.
   */
  async function rollbackUpgrade(server: GameServer, sent: boolean): Promise<void> {
    try {
      if (sent) {
        const built = await specForRow(server);
        await storeStatus(server.id, await provision(server.hostId, built.spec, built.specHash, false));
      }
      await pruneStrayPorts(server.id);
    } catch (error) {
      console.warn(`server ${server.id}: the old spec couldn't be provisioned again after a failed upgrade; the next start or hello does it (${(error as Error).message})`);
    }
  }

  /**
   * Free the server's allocations its current definition has no published port for (left by a failed upgrade). Only
   * called once the agent is known to run the row's spec.
   */
  async function pruneStrayPorts(serverId: string): Promise<void> {
    const row = await GameServer.findByPk(serverId, { include: [{ association: "definition" }, { association: "ports" }] });
    if (!row || row.state === "deleting" || !row.definition) return;
    const wanted = (row.definition.document.ports ?? []).filter((port) => !port.internal);
    const stray = row.ports!.filter((allocation) => !wanted.some((port) => port.name === allocation.name && port.proto === allocation.proto));
    if (stray.length === 0) return;
    await PortAllocation.destroy({ where: { id: stray.map((allocation) => allocation.id), serverId } });
  }

  /**
   * After the agent's `port_in_use`: give the server another port for the allocation that holds `taken`, skipping it
   * (the host's other software has it). Pinned ports aren't moved.
   * @param onlyIds Allocations that may move (an upgrade's new ones); null = any of the server's.
   * @returns The server's allocations afterwards, or null when no allocation of this server may move (a retry can't help).
   */
  async function replacePort(hostId: string, serverId: string, ports: PortDecl[], taken: PortInUse, onlyIds: number[] | null): Promise<PortAllocation[] | null> {
    return await sequelize.transaction(async (transaction) => {
      const host = await Host.findByPk(hostId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!host) return null;
      const row = await PortAllocation.findOne({ where: { hostId, serverId, proto: taken.proto, port: taken.port }, transaction });
      if (!row || row.pinned || (onlyIds !== null && !onlyIds.includes(row.id))) return null;
      const decl = ports.find((port) => port.name === row.name && port.proto === row.proto && !port.internal);
      if (!decl) return null;
      await row.destroy({ transaction });
      await PortAllocation.allocate(host, serverId, [decl], transaction, undefined, [`${taken.proto}/${taken.port}`]);
      return await PortAllocation.findAll({ where: { serverId }, transaction });
    });
  }

  interface SpecValues {
    id: string;
    name: string;
    variables: Record<string, Value>;
    limits: Limits;
    autostart: boolean;
    autoRestart: boolean;
    allowPrivateNetwork: boolean;
  }

  /**
   * The spec for a server with these values: allocations → port bindings (internal ports use their declared default).
   */
  async function specFor(definition: Definition, values: SpecValues, allocations: PortAllocation[]): Promise<{ spec: ServerSpec; specHash: string }> {
    const ports: PortBinding[] = (definition.document.ports ?? []).map((decl) => {
      if (decl.internal) return { name: decl.name, proto: decl.proto, port: decl.default!, internal: true };
      const allocation = allocations.find((row) => row.name === decl.name && row.proto === decl.proto);
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
        allowPrivateNetwork: values.allowPrivateNetwork,
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
      allowPrivateNetwork: server.allowPrivateNetwork,
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
      const port = (error as { port?: PortInUse }).port;
      if (code === "port_in_use" && port) throw new PortInUseError(message, port);
      if (code === "conflict" || code === "port_in_use") throw HttpError.conflict(message);
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
    _agentSpecHash.set(serverId, status.specHash);
    const row = await GameServer.findByPk(serverId);
    if (!row) return;
    if (status.services !== undefined && row.state !== "deleting") await storeServices(row, status.services);
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
      allowPrivateNetwork: server.allowPrivateNetwork,
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
          optionsFrom: decl.options_from !== undefined,
          pattern: decl.pattern ?? null,
          value: decl.type === "secret" ? null : value,
          isSet: value !== null && value !== "",
        };
      });
    const source = server.definition!.source;
    const newest = source?.enabled === false ? null : await Definition.findOne({
      where: { sourceId: server.definition!.sourceId, gameId: server.definition!.gameId, active: true, id: { [Op.ne]: server.definitionId } },
      attributes: ["id", "commit", "updatedAt"],
    });
    return {
      ...toDto(server),
      variables,
      updateAvailable: newest !== null,
      latestDefinition: newest ? { id: newest.id, commit: newest.commit, syncedAt: newest.updatedAt.toISOString() } : null,
      source: { name: source?.name ?? "", kind: source?.kind ?? "local" },
      services: server.servicesStatus ?? [],
      canUpdateGame: canUpdateGame(server.definition!.document),
      installed: server.installedAt !== null,
    };
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
  async function assertHostCapacity(host: Host, limits: Limits, excludeId: string | null, document: GameDefinition, transaction?: Transaction): Promise<void> {
    const others = await GameServer.findAll({
      where: { hostId: host.id, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) },
      attributes: ["memoryMb", "cpuMillis", "diskMb"],
      include: [{ association: "definition", attributes: ["id", "document"] }],
      transaction,
    });
    const used = {
      memoryMb: others.reduce((sum, row) => sum + row.memoryMb + serviceTotals(row.definition!.document).memoryMb, 0),
      cpuMillis: others.reduce((sum, row) => sum + row.cpuMillis + serviceTotals(row.definition!.document).cpuMillis, 0),
      diskMb: others.reduce((sum, row) => sum + row.diskMb, 0),
    };
    const own = serviceTotals(document);
    const needs = { memoryMb: limits.memoryMb + own.memoryMb, cpuMillis: limits.cpuMillis + own.cpuMillis, diskMb: limits.diskMb };
    const facts = host.facts;
    const capacity = {
      memoryMb: host.maxMemoryMb ?? (facts ? Math.max(0, Math.floor(facts.memory.totalBytes / 1048576) - MEMORY_RESERVE_MB) : null),
      cpuMillis: host.maxCpuMillis ?? (facts ? facts.cpu.threads * 1000 : null),
      diskMb: host.maxDiskMb ?? (facts ? Math.floor(facts.disk.totalBytes / 1048576) : null),
    };
    const checks: [keyof typeof used, string, string][] = [["memoryMb", "memory", "MB"], ["cpuMillis", "CPU", "thousandths of a CPU"], ["diskMb", "disk space", "MB"]];
    for (const [key, label, unit] of checks) {
      const max = capacity[key];
      if (max !== null && used[key] + needs[key] > max) {
        throw HttpError.conflict(`${host.name} doesn't have enough ${label} left: this server needs ${needs[key]} ${unit}${own.memoryMb ? " (including its services)" : ""}, ${Math.max(0, max - used[key])} of ${max} ${unit} are free.`);
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

  /**
   * `allowPrivateNetwork` from a body: only users with SERVERS_PRIVATE_NETWORK may send it at all.
   * @throws HttpError 403 for anyone else, 400 when it isn't a boolean.
   */
  function parsePrivateNetwork(user: User, value: unknown): boolean | undefined {
    if (value === undefined) return undefined;
    if (!user.hasPermission("SERVERS_PRIVATE_NETWORK")) throw HttpError.forbidden("You may not change whether a server can reach private networks. Ask an administrator.");
    return parseFlag(value, "allowPrivateNetwork");
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
