import type { HostAgentDto } from "@shared/api/hosts.ts";
import type { AgentUpdateStatus } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { AgentGateway } from "../gateways/agent/AgentGateway.ts";
import { pushHostUpdated } from "../gateways/agent/hostEvents.ts";
import { AgentBuilds } from "../lib/agentBuilds.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuditLog, Host } from "../models/index.ts";
import { agentErrorToHttp } from "../servers/agentCall.ts";

/**
 * The OS the panel serves agents for; `facts.os.arch` picks the build. Agents run on Linux only.
 */
const AGENT_OS = "linux";

/**
 * Updating the agents (M6): which build each host runs against the one the panel serves, the manual and the automatic
 * update, and the progress of the running one. Progress lives in memory per host id: after a panel restart it is gone
 * (the host's next hello compares builds anyway).
 */
export namespace AgentUpdater {
  /**
   * Why an update was requested.
   */
  export type Reason = "manual" | "auto";

  /**
   * The update the panel last asked a host for. Kept apart from the shown status, which a reconnect can drop, so the
   * reason of a late event is still known.
   */
  interface Requested {
    sha256: string;
    reason: Reason;
    events: number; // `agent.updateStatus` events received for `sha256` since the request was sent.
  }

  const _status = new Map<string, AgentUpdateStatus>();
  const _requested = new Map<string, Requested>();
  /**
   * Host id → the build an automatic update of it failed for. Stops a failing update from repeating on every
   * reconnect: it is tried again only for another build, after a manual update, or when the setting is switched on again.
   */
  const _autoFailed = new Map<string, string>();

  /**
   * The latest update's progress for a host, or null (none since the panel started, or it finished).
   */
  export function status(hostId: string): AgentUpdateStatus | null {
    return _status.get(hostId) ?? null;
  }

  /**
   * Whether an update is under way (downloading, waiting for operations, or restarting).
   */
  export function isInFlight(hostId: string): boolean {
    const state = _status.get(hostId)?.state;
    return state === "downloading" || state === "waiting" || state === "restarting";
  }

  /**
   * The build the panel serves for a host's architecture, or null (no facts yet, or no build for it).
   */
  async function latestFor(host: Host): Promise<string | null> {
    return host.facts ? await AgentBuilds.latest(AGENT_OS, host.facts.os.arch) : null;
  }

  /**
   * `HostDto.agent` for a host.
   * @param includeUpdate Whether to include the update's progress (HOSTS_MANAGE only: it names running operations and
   * carries the agent's messages). Builds and `upToDate` are shown to everyone who sees the host.
   */
  export async function describe(host: Host, includeUpdate: boolean): Promise<HostAgentDto> {
    const build = host.facts?.agentBuild ?? null;
    const latestBuild = await latestFor(host);
    return {
      build,
      latestBuild,
      upToDate: build !== null && latestBuild !== null ? build === latestBuild : null,
      autoUpdate: host.autoUpdateAgent,
      update: includeUpdate ? status(host.id) : null,
    };
  }

  /**
   * The command that updates an agent too old to update from the panel.
   */
  function installCommand(): string {
    return `curl -fsSL ${Config.PUBLIC_URL}/api/agent/install.sh | sudo bash`;
  }

  /**
   * Ask a host's agent to update to the build the panel serves. The agent answers at once; progress follows as
   * `agent.updateStatus` events (`onStatus`). Audit `host.agent_update` `{ build, reason }`; pushes `host.updated`.
   * A manual request also lets automatic updates try the current build again.
   * @param actorId The user who clicked Update (manual).
   * @param ip The actor's address, for the audit log.
   * @throws HttpError 409 when the host is offline, the panel has no build for its architecture, it already runs
   * that build, an update is under way (automatic requests only: a manual one replaces it), or the agent is too old.
   */
  export async function request(host: Host, reason: Reason, actorId?: number, ip?: string | null): Promise<AgentUpdateStatus | null> {
    if (!AgentGateway.isOnline(host.id)) throw HttpError.conflict(`${host.name} is offline. Start gss-agent on it, then update.`);
    const facts = host.facts;
    if (!facts) throw HttpError.conflict(`${host.name} hasn't reported its system yet, so the panel can't pick an agent build for it.`);
    const target = await AgentBuilds.latest(AGENT_OS, facts.os.arch);
    if (target === null) {
      throw HttpError.conflict(`The panel has no agent build for ${AGENT_OS}/${facts.os.arch}. Run \`make dist\` in agent/ (the Docker image includes it).`);
    }
    if (facts.agentBuild === target) throw HttpError.conflict(`${host.name} already runs the agent build this panel serves.`);
    if (reason === "manual") _autoFailed.delete(host.id);
    else if (isInFlight(host.id)) throw HttpError.conflict(`An agent update of ${host.name} is already under way.`);

    const sent: Requested = { sha256: target, reason, events: 0 };
    _requested.set(host.id, sent);
    let answer: AgentUpdateStatus;
    try {
      // A manual update may reinstall a build the agent rolled back before; an automatic one never does.
      answer = await AgentGateway.request(host.id, "agent.update", { sha256: target, force: reason === "manual" });
    } catch (error) {
      if (reason === "auto" && AgentGateway.isOnline(host.id)) _autoFailed.set(host.id, target);
      if ((error as { code?: string }).code === "unsupported" && AgentGateway.isOnline(host.id)) {
        throw HttpError.conflict(`The agent on ${host.name} is too old to update from the panel. Run \`${installCommand()}\` on the host once; later updates work from here.`);
      }
      throw agentErrorToHttp(host.id, error);
    }

    // Events travel on another queue than the answer, so a newer status for this build may have arrived first: it wins.
    if (_requested.get(host.id) === sent && sent.events === 0) {
      if (answer.state === "current") _status.delete(host.id);
      else _status.set(host.id, answer);
    }
    if (answer.state === "failed" && reason === "auto") _autoFailed.set(host.id, target);
    await AuditLog.record({ action: "host.agent_update", actorId, hostId: host.id, ip, details: { build: target, reason } });
    void pushHostUpdated(host.id);
    return status(host.id);
  }

  /**
   * An `agent.updateStatus` event: store it and let the browsers refetch. `current` clears the status; a failed
   * automatic update is remembered (see `_autoFailed`).
   */
  export function onStatus(hostId: string, update: AgentUpdateStatus): void {
    const requested = _requested.get(hostId);
    if (requested?.sha256 === update.sha256) requested.events++;
    if (update.state === "current") _status.delete(hostId);
    else {
      _status.set(hostId, update);
      if (update.state === "failed" && requested?.sha256 === update.sha256 && requested.reason === "auto") _autoFailed.set(hostId, update.sha256);
    }
    void pushHostUpdated(hostId);
  }

  /**
   * Settle what the host's earlier update came to now that it has said hello again (its facts are already stored).
   * Running the requested build clears the status; another build after `restarting` marks it failed; a status still
   * downloading or waiting is dropped, since a reconnect usually means the agent restarted and forgot it.
   * @returns Whether the status changed (the caller pushes `host.updated`).
   */
  export function onHello(host: Host): boolean {
    const current = _status.get(host.id);
    if (!current) return false;
    const build = host.facts?.agentBuild ?? null;
    if (build === current.sha256) {
      _status.delete(host.id);
      if (_requested.get(host.id)?.sha256 === current.sha256) _requested.delete(host.id);
      return true;
    }
    if (current.state === "restarting") {
      const shown = build ? `build ${build.slice(0, 12)}` : "a build the panel can't identify";
      _status.set(host.id, {
        state: "failed",
        sha256: current.sha256,
        message: `The agent restarted but still runs ${shown} instead of ${current.sha256.slice(0, 12)}. Check \`journalctl -u gss-agent\` on the host.`,
        waitingFor: [],
      });
      const requested = _requested.get(host.id);
      if (requested?.sha256 === current.sha256 && requested.reason === "auto") _autoFailed.set(host.id, current.sha256);
    }
    else if (current.state !== "failed") _status.delete(host.id);
    return true;
  }

  /**
   * Request an update when the host opted in (`autoUpdateAgent`, read again from the database so a switch turned off a
   * moment ago wins), is enabled, online and out of date, none is under way, and an automatic one hasn't already failed
   * for this build. Never throws: failures are logged.
   * @param actorId The admin whose change of the setting triggered it (audit); none when a reconnect did.
   * @param ip The actor's address, for the audit log.
   */
  export async function autoUpdate(hostId: string, actorId?: number, ip?: string | null): Promise<void> {
    if (!AgentGateway.isOnline(hostId) || isInFlight(hostId)) return;
    try {
      const host = await Host.findByPk(hostId);
      if (!host || !host.autoUpdateAgent || host.disabled) return;
      const { upToDate, latestBuild } = await describe(host, false);
      if (upToDate !== false || latestBuild === null) return;
      if (_autoFailed.get(hostId) === latestBuild) return;
      await request(host, "auto", actorId, ip);
    } catch (error) {
      console.warn(`automatic agent update of host ${hostId} failed: ${(error as Error).message}`);
    }
  }

  /**
   * The setting was switched on: let automatic updates try again even for a build that failed before.
   */
  export function resetAutoFailure(hostId: string): void {
    _autoFailed.delete(hostId);
  }
}

export default AgentUpdater;
