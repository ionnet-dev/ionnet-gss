/**
 * `/api/hosts` and `/api/enrol-tokens`.
 */
import type { IsoDate } from "./common.ts";
import type { HostFacts } from "../protocol/protocol.gen.ts";

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
}

//#region Grants (M5)
export interface HostGrantDto {
  userId: number;
  username: string;
  createdAt: IsoDate;
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
}
//#endregion
