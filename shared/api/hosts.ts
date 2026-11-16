/**
 * `/api/hosts` and `/api/enrol-tokens`.
 */
import type { IsoDate } from "./common.ts";
import type { AgentUpdateStatus, HostFacts } from "../protocol/protocol.gen.ts";

export interface HostDto {
  id: string; // UUID.
  name: string;
  /**
   * Address players connect to. null = the hostname from the facts.
   */
  address: string | null;
  online: boolean;
  disabled: boolean;
  agentVersion: string | null;
  lastSeenAt: IsoDate | null;
  enrolledAt: IsoDate;
  /**
   * Comma-separated port ranges, e.g. `25565-25664,27015-27064`.
   */
  portPool: string;
  capacity: HostCapacityDto;
  serverCount: number;
  facts: HostFacts | null; // Last facts the agent reported. null = never reported.
  /**
   * The caller may create servers here (M5): SERVERS_CREATE and either SERVERS_MANAGE_ALL or a grant. The create
   * page's host picker shows only these.
   */
  canCreate: boolean;
  /**
   * The agent's build, whether it is the one this panel serves, and the progress of an update (M6).
   */
  agent: HostAgentDto;
}

/**
 * Agent version state of a host (M6). Builds are SHA-256 digests of the gss-agent binary.
 */
export interface HostAgentDto {
  build: string | null; // The running binary. null = unknown (never connected, or an agent older than M6).
  latestBuild: string | null; // What the panel serves for the host's arch. null = the panel has no build for it.
  /**
   * true = runs `latestBuild`; false = out of date; null = can't tell (`build` or `latestBuild` unknown).
   */
  upToDate: boolean | null;
  /**
   * Update the agent automatically when it connects with an older build (the panel was upgraded, or the setting was
   * just turned on). Off by default.
   */
  autoUpdate: boolean;
  /**
   * The latest update's progress, kept in the panel's memory. null = none since the panel started, or it finished
   * (the agent reconnected with the new build).
   */
  update: AgentUpdateStatus | null;
}

/**
 * What the panel lets servers use on this host. `null` = derive from the facts (total RAM, threads, disk).
 */
export interface HostCapacityDto {
  maxMemoryMb: number | null;
  maxCpuMillis: number | null;
  maxDiskMb: number | null;
}

export interface HostDetailResponse extends HostDto {
  grants: HostGrantDto[]; // Empty for non-admins.
}

export interface UpdateHostBody {
  name?: string;
  address?: string | null;
  disabled?: boolean;
  portPool?: string;
  capacity?: Partial<HostCapacityDto>;
  autoUpdateAgent?: boolean; // M6
}

//#region Grants (M5)
export interface HostGrantDto {
  userId: number;
  username: string;
  createdAt: IsoDate;
}

/**
 * `POST /api/hosts/:id/grants`. By username: HOSTS_MANAGE may not hold USERS_MANAGE, so there's no user list.
 */
export interface CreateHostGrantBody {
  username: string;
}
//#endregion

//#region Enrol tokens
export interface EnrolTokenDto {
  id: number;
  name: string | null; // Name the new host gets; null = its hostname.
  tokenHint: string;
  createdBy: string | null;
  expiresAt: IsoDate;
  usedAt: IsoDate | null;
  hostId: string | null; // The host that used it.
  createdAt: IsoDate;
}

export interface CreateEnrolTokenBody {
  name?: string | null;
  expiresInMinutes?: number; // Default: ENROL_TOKEN_TTL_MINUTES.
}

/**
 * The token is in the response once; only its hash is stored.
 */
export interface EnrolTokenCreatedResponse {
  enrolToken: EnrolTokenDto;
  token: string;
  /**
   * Ready-to-paste command for the host, e.g. `sudo gss-agent enrol --panel https://gss.ionnet.dev --token gss_enrol_…`.
   */
  command: string;
  /**
   * M5: one line that installs Docker, the agent and its systemd unit and enrols, e.g.
   * `curl -fsSL https://gss.ionnet.dev/api/agent/install.sh | sudo GSS_ENROL_TOKEN=gss_enrol_… bash`.
   */
  installCommand: string;
}
//#endregion
