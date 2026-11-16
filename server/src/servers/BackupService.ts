/**
 * Backups and restore (M4). The panel keeps the rows (`backups`) and the per-server limit; the agent does the work
 * (backup.json) and reports `backup.progress` / `backup.finished`. One operation per server at a time, known here in
 * memory (`_operations`, from the create/restore answers, progress events and every hello's
 * `ServerStatus.operation`).
 *
 *   create   ServerAccess(manage) → state not creating/installing/deleting (409) → no operation (409) →
 *            assertSlot (409) → row `pending` (file = `backups/<id>.tar.zst`) → backup.create → row `running`,
 *            startedAt → push `backup.updated`. A refusal destroys the row and rethrows (409/507 from the agent); no
 *            answer (504/503) keeps it `failed` ("didn't confirm"), since the agent may run it anyway.
 *   finished `done` + sizeBytes + finishedAt, or `failed` + error; push `backup.updated`; audit `backup.finished`.
 *            An ok finish also settles a row the panel only presumed failed (reconcile, no answer): the finish can
 *            sit in the agent's outbox behind console batches and arrive after the hello's reconcile.
 *   restore  stopped/crashed/install_failed only (409), backup `done` (409), no operation → backup.restore → push
 *            `backup.updated`; on finish audit `server.restored` (ok or not) and push `server.updated`.
 *   delete   not the running one (409) → backup.delete (idempotent on the agent) → destroy row. Failed rows too (their
 *            file may exist if the agent died right after finishing). Host offline → 409.
 *   hello    reconcile: a `pending`/`running` row the agent doesn't name in `ServerStatus.operation` → `failed`
 *            ("The host's agent restarted while the backup ran."); a named one is (re)stored in `_operations`.
 *
 * `backup.finished` can overtake the answer to `backup.create`/`backup.restore` (a tiny backup finishes in
 * milliseconds): rows only move forward (`pending` → `running` → `done`/`failed`, by conditional updates), and a
 * finish that arrives first is remembered (`_finishedEarly`) so the late answer doesn't bring the operation back.
 *
 * Quota seam: `assertSlot` counts this server's non-failed backups against the owner's `maxBackups`
 * (DEFAULT_QUOTA_BACKUPS when null); admins pass. M5 replaces it with the user-wide `Quota.assertFits`.
 */
import { Op } from "sequelize";
import type { BackupDto, BackupListResponse, BackupOperationDto, CreateBackupBody, RestoreBackupResponse } from "@shared/api/backups.ts";
import type { DownloadTicketResponse } from "@shared/api/files.ts";
import { LIMITS } from "@shared/constants.ts";
import { BACKUP_EXTENSION, type BackupFinished, type BackupOperationStatus, type BackupProgress, type ServerStatus } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { LiveGateway } from "../gateways/live/LiveGateway.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, Backup, GameServer, Quota, User } from "../models/index.ts";
import { DownloadTickets } from "../transfers/DownloadTickets.ts";
import { callAgent } from "./agentCall.ts";
import { ServerAccess } from "./ServerAccess.ts";

export namespace BackupService {
  /**
   * The running operation per server id.
   */
  const _operations = new Map<string, BackupOperationDto>();
  /**
   * Servers with a create or restore request on its way to the agent (two clicks must not start two operations).
   */
  const _starting = new Set<string>();
  /**
   * `backup.finished` events that came before the agent's answer, by `serverId:operation:backupId`.
   */
  const _finishedEarly = new Set<string>();

  /**
   * The panel's own verdict on a backup whose end it didn't hear: the hello named no operation for it.
   */
  const AGENT_RESTARTED = "The host's agent restarted while the backup ran.";
  /**
   * The panel's own verdict on a backup.create without an answer.
   */
  const UNCONFIRMED = "The host didn't confirm the backup in time. If it ran anyway, this entry turns done once the host reports it; deleting it also removes the file on the host.";
  /**
   * Errors of rows marked failed by the panel, not the agent: an ok `backup.finished` still settles them as done.
   */
  const PRESUMED_FAILED = [AGENT_RESTARTED, UNCONFIRMED];

  const RESTORABLE_STATES = ["stopped", "crashed", "install_failed"];
  const INSTALLING_STATES = ["creating", "installing"];
  const LIST_INCLUDE = [{ association: "createdBy", attributes: ["id", "username"] }];

  export async function list(user: User, serverId: string): Promise<BackupListResponse> {
    const server = await ServerAccess.get(user, serverId, "manage");
    const rows = await Backup.findAll({ where: { serverId: server.id }, include: LIST_INCLUDE, order: [["createdAt", "DESC"], ["id", "DESC"]] });
    return { backups: rows.map(toDto), operation: operationOf(server.id), limit: await slot(server) };
  }

  export async function create(user: User, serverId: string, body: Partial<CreateBackupBody>): Promise<BackupDto> {
    const server = await ServerAccess.get(user, serverId, "manage");
    if (INSTALLING_STATES.includes(server.state)) throw HttpError.conflict("Wait until the install finishes.");
    if (server.state === "deleting") throw HttpError.conflict("The server is being deleted.");
    const name = parseName(body.name);
    return await starting(server.id, async () => {
      await assertSlot(server);
      const row = await Backup.create({ serverId: server.id, createdById: user.id, name, status: "pending", file: null, sizeBytes: null, error: null, startedAt: null, finishedAt: null });
      row.file = `backups/${row.id}${BACKUP_EXTENSION}`;
      await row.save();
      let status: BackupOperationStatus;
      try {
        status = await callAgent(server.hostId, "backup.create", { serverId: server.id, backupId: row.id });
      } catch (error) {
        if (isDefiniteRefusal(error)) {
          await row.destroy();
        }
        else {
          // No answer (timeout, dropped connection): the agent may run the backup anyway. Keep the row as failed so
          // deleting it cleans the host; a later ok `backup.finished` still turns it done (applyFinished).
          await Backup.update({ status: "failed", error: UNCONFIRMED, finishedAt: new Date() }, { where: { id: row.id, status: "pending" } });
          pushUpdated(server, row.id);
        }
        throw error;
      }
      remember(status);
      await Backup.update({ status: "running", startedAt: new Date(status.startedAt) }, { where: { id: row.id, status: "pending" } });
      pushUpdated(server, row.id);
      const fresh = await Backup.findByPk(row.id, { include: LIST_INCLUDE });
      return toDto(fresh ?? row);
    });
  }

  export async function remove(user: User, serverId: string, backupId: number): Promise<void> {
    const server = await ServerAccess.get(user, serverId, "manage");
    const row = await findRow(server, backupId);
    if (operationOf(server.id)?.backupId === row.id || row.status === "pending" || row.status === "running") {
      throw HttpError.conflict("This backup is being created or restored right now. Delete it once that finishes.");
    }
    await callAgent(server.hostId, "backup.delete", { serverId: server.id, backupId: row.id });
    await row.destroy();
    pushUpdated(server, row.id);
  }

  export async function restore(user: User, serverId: string, backupId: number): Promise<RestoreBackupResponse> {
    const server = await ServerAccess.get(user, serverId, "manage");
    if (!RESTORABLE_STATES.includes(server.state)) throw HttpError.conflict("Stop the server first.");
    const row = await findRow(server, backupId);
    if (row.status !== "done") throw HttpError.conflict("Only a finished backup can be restored.");
    return await starting(server.id, async () => {
      const status = await callAgent(server.hostId, "backup.restore", { serverId: server.id, backupId: row.id });
      const operation = remember(status) ?? toOperation(status);
      pushUpdated(server, row.id);
      return { ok: true, operation };
    });
  }

  /**
   * A download ticket for a `done` backup, named `<server name>-<backup id>.tar.zst` (409 otherwise).
   */
  export async function downloadTicket(user: User, serverId: string, backupId: number): Promise<DownloadTicketResponse> {
    const server = await ServerAccess.get(user, serverId, "manage");
    const row = await findRow(server, backupId);
    if (row.status !== "done") throw HttpError.conflict("Only a finished backup can be downloaded.");
    const base = server.name.replace(/[^\w.\- ]+/g, "_").trim() || "server";
    return DownloadTickets.issue({
      userId: user.id,
      hostId: server.hostId,
      source: { serverId: server.id, source: "backup", backupId: row.id },
      fileName: `${base}-${row.id}${BACKUP_EXTENSION}`,
    });
  }

  /**
   * The operation a server runs right now, or null.
   */
  export function operationOf(serverId: string): BackupOperationDto | null {
    return _operations.get(serverId) ?? null;
  }

  /**
   * `backup.progress`: update `_operations` and push `backup.progress` to `server:<id>`. Ignores other hosts' servers.
   */
  export async function applyProgress(hostId: string, progress: BackupProgress): Promise<void> {
    const server = await GameServer.findByPk(progress.serverId, { attributes: ["id", "hostId", "ownerId"] });
    if (!server || server.hostId !== hostId) return;
    if (_finishedEarly.has(key(progress.serverId, progress.operation, progress.backupId))) return;
    const current = _operations.get(server.id);
    if (current && current.backupId === progress.backupId && current.operation === progress.operation) {
      current.bytes = progress.bytes;
      current.totalBytes = progress.totalBytes;
    }
    else {
      _operations.set(server.id, { backupId: progress.backupId, operation: progress.operation, bytes: progress.bytes, totalBytes: progress.totalBytes, startedAt: progress.at });
    }
    LiveGateway.push("backup.progress", {
      serverId: server.id,
      backupId: progress.backupId,
      operation: progress.operation,
      bytes: progress.bytes,
      totalBytes: progress.totalBytes,
    }, { topic: `server:${server.id}` });
  }

  /**
   * `backup.finished`: settle the row (see the module doc), clear `_operations`, push.
   */
  export async function applyFinished(hostId: string, finished: BackupFinished): Promise<void> {
    const server = await GameServer.findByPk(finished.serverId, { attributes: ["id", "hostId", "ownerId", "name"] });
    if (!server || server.hostId !== hostId) return;
    const current = _operations.get(server.id);
    if (current && current.backupId === finished.backupId && current.operation === finished.operation) {
      _operations.delete(server.id);
    }
    else if (_starting.has(server.id)) {
      rememberEarly(key(server.id, finished.operation, finished.backupId));
    }
    const at = Number.isNaN(Date.parse(finished.at)) ? new Date() : new Date(finished.at);

    if (finished.operation === "create") {
      // An open row settles either way. A row the panel only presumed failed (reconcile after a reconnect, or no
      // answer to backup.create) takes an ok finish: the agent's word wins, so a good backup isn't shown as failed.
      const open = { status: { [Op.in]: ["pending", "running"] } };
      const presumed = { status: "failed", error: { [Op.in]: PRESUMED_FAILED } };
      const [settled] = finished.ok
        ? await Backup.update({ status: "done", sizeBytes: finished.sizeBytes, error: null, finishedAt: at }, { where: { id: finished.backupId, serverId: server.id, [Op.or]: [open, presumed] } })
        : await Backup.update({ status: "failed", error: finished.error ?? "The backup failed.", finishedAt: at }, { where: { id: finished.backupId, serverId: server.id, ...open } });
      if (settled > 0) {
        await AuditLog.record({ action: "backup.finished", hostId, serverId: server.id, details: { backupId: finished.backupId, ok: finished.ok, sizeBytes: finished.sizeBytes, error: finished.error } });
      }
    }
    else {
      await AuditLog.record({ action: "server.restored", hostId, serverId: server.id, details: { backupId: finished.backupId, ok: finished.ok, error: finished.error } });
      LiveGateway.push("server.updated", { serverId: server.id }, audience(server.ownerId));
    }
    pushUpdated(server, finished.backupId);
  }

  /**
   * After a hello: align rows and `_operations` with the agent's `ServerStatus.operation`s.
   */
  export async function reconcile(hostId: string, servers: ServerStatus[]): Promise<void> {
    const reported = new Map(servers.map((status) => [status.serverId.toLowerCase(), status.operation ?? null]));
    const rows = await GameServer.findAll({ where: { hostId }, attributes: ["id", "ownerId"] });
    const owners = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      const operation = reported.get(row.id) ?? null;
      const known = _operations.get(row.id);
      if (operation) {
        _operations.set(row.id, toOperation(operation));
      }
      else if (known) {
        // The restore's own `backup.finished` (sent from the agent's journal recovery) audits it.
        _operations.delete(row.id);
        pushUpdated(row, known.backupId);
      }
    }
    // Rows the agent is not working on any more: it restarted (or lost the request) while the backup ran.
    const stale = await Backup.findAll({ where: { serverId: { [Op.in]: [...owners.keys()] }, status: { [Op.in]: ["pending", "running"] } } });
    for (const backup of stale) {
      const operation = reported.get(backup.serverId);
      if (operation?.operation === "create" && operation.backupId === backup.id) continue;
      if (_starting.has(backup.serverId) && backup.status === "pending") continue; // Its create request is in flight.
      const [settled] = await Backup.update(
        { status: "failed", error: AGENT_RESTARTED, finishedAt: new Date() },
        { where: { id: backup.id, status: { [Op.in]: ["pending", "running"] } } },
      );
      if (settled > 0) {
        await AuditLog.record({ action: "backup.finished", hostId, serverId: backup.serverId, details: { backupId: backup.id, ok: false, error: "agent restarted" } });
        pushUpdated(owners.get(backup.serverId)!, backup.id);
      }
    }
  }

  /**
   * Refuse a new backup when the server already holds the owner's `maxBackups` (non-failed rows). The M5 seam.
   * @throws HttpError 409 "This server already has 5 backups, the most your quota allows. Delete an old one first."
   */
  export async function assertSlot(server: GameServer): Promise<{ max: number | null; used: number }> {
    const limit = await slot(server);
    if (limit.max !== null && limit.used >= limit.max) {
      throw HttpError.conflict(`This server already has ${limit.used} backups, the most your quota allows (${limit.max}). Delete an old one first.`);
    }
    return limit;
  }

  /**
   * The client shape of a row (createdBy included when loaded).
   */
  export function toDto(backup: Backup): BackupDto {
    const createdBy = (backup as Backup & { createdBy?: User | null }).createdBy;
    return {
      id: backup.id,
      name: backup.name,
      status: backup.status,
      sizeBytes: backup.sizeBytes === null ? null : Number(backup.sizeBytes),
      error: backup.error,
      createdBy: createdBy ? { id: createdBy.id, username: createdBy.username } : null,
      startedAt: backup.startedAt?.toISOString() ?? null,
      finishedAt: backup.finishedAt?.toISOString() ?? null,
      createdAt: backup.createdAt.toISOString(),
    };
  }

  /**
   * The owner's limit and this server's count of non-failed backups. An admin owner has no limit (`max` null).
   */
  async function slot(server: GameServer): Promise<{ max: number | null; used: number }> {
    const used = await Backup.count({ where: { serverId: server.id, status: { [Op.ne]: "failed" } } });
    const owner = await User.findWithRoles({ id: server.ownerId });
    if (owner?.isAdmin()) return { max: null, used };
    const quota = await Quota.findOne({ where: { userId: server.ownerId }, attributes: ["maxBackups"] });
    const max = quota?.maxBackups ?? Config.DEFAULT_QUOTA_BACKUPS;
    return { max, used };
  }

  async function findRow(server: GameServer, backupId: number): Promise<Backup> {
    const row = await Backup.findOne({ where: { id: backupId, serverId: server.id } });
    if (!row) throw HttpError.notFound("There is no backup with that id on this server.");
    return row;
  }

  /**
   * Run `fn` as the only create/restore request of a server; 409 when an operation runs or another request is on
   * its way.
   */
  async function starting<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const running = _operations.get(serverId);
    if (running) throw HttpError.conflict(`A ${running.operation === "create" ? "backup" : "restore"} of this server is running. Try again when it finishes.`);
    if (_starting.has(serverId)) throw HttpError.conflict("Another backup or restore of this server is starting. Try again in a moment.");
    _starting.add(serverId);
    try {
      return await fn();
    } finally {
      _starting.delete(serverId);
    }
  }

  /**
   * Store the agent's answer as the running operation, unless its `backup.finished` already came.
   */
  function remember(status: BackupOperationStatus): BackupOperationDto | null {
    const operation = toOperation(status);
    if (_finishedEarly.delete(key(status.serverId, status.operation, status.backupId))) return null;
    _operations.set(status.serverId.toLowerCase(), operation);
    return operation;
  }

  function rememberEarly(k: string): void {
    _finishedEarly.add(k);
    setTimeout(() => _finishedEarly.delete(k), 5 * 60_000); // Answers come within the agent request timeout.
  }

  function key(serverId: string, operation: string, backupId: number): string {
    return `${serverId.toLowerCase()}:${operation}:${backupId}`;
  }

  /**
   * Whether a failed agent request certainly didn't start anything: the host refused (400/404/409/413/507 and the
   * other answers) or was offline. A timeout (504) or a connection that dropped before the answer (503) is uncertain.
   */
  function isDefiniteRefusal(error: unknown): boolean {
    return error instanceof HttpError && error.status !== 503 && error.status !== 504;
  }

  function toOperation(status: BackupOperationStatus): BackupOperationDto {
    return { backupId: status.backupId, operation: status.operation, bytes: status.bytes, totalBytes: status.totalBytes ?? null, startedAt: status.startedAt };
  }

  function parseName(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return `Backup ${stamp} UTC`;
    }
    if (typeof raw !== "string") throw HttpError.badRequest("\"name\" must be a string.");
    const name = raw.trim();
    if (!name) throw HttpError.badRequest("\"name\" can't be only spaces.");
    if (name.length > LIMITS.BACKUP_NAME_MAX) throw HttpError.badRequest(`"name" can be at most ${LIMITS.BACKUP_NAME_MAX} characters long.`);
    return name;
  }

  function audience(ownerId: number): LiveGateway.Audience {
    return { permission: "SERVERS_MANAGE_ALL", userIds: [ownerId] };
  }

  function pushUpdated(server: Pick<GameServer, "id" | "ownerId">, backupId: number | null): void {
    LiveGateway.push("backup.updated", { serverId: server.id, backupId }, audience(server.ownerId));
  }
}

export default BackupService;
