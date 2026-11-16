/**
 * `/api/users`, `/api/roles` and quotas.
 */
import type { IsoDate } from "./common.ts";
import type { Permission } from "../permissions.ts";

export interface RoleDto {
  id: number;
  name: string;
  description: string | null;
  permissions: Permission[];
  inherits: string | null; // Name of the role this one inherits from.
}

export interface UserDto {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  roles: string[];
  /**
   * Effective permissions after role inheritance. Admins get every key.
   */
  permissions: Permission[];
  isAdmin: boolean;
  totpEnabled: boolean;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface CreateUserBody {
  username: string;
  password: string;
  email?: string | null;
  displayName?: string | null;
  roles?: string[]; // Role names. Default: [ROLES.USER].
}

export interface UpdateUserBody {
  email?: string | null;
  displayName?: string | null;
  disabled?: boolean;
  roles?: string[];
}

/**
 * `PATCH /api/users/:id`. A role change ends the user's sessions; when the caller changed their own roles, `token`
 * is a fresh session token the client stores in place of the old one (which stopped working). null otherwise.
 */
export interface UpdateUserResponse extends UserDto {
  token: string | null;
}

export interface SetUserPasswordBody {
  password: string;
}

/**
 * A user's quota. `null` = use the panel default (`DEFAULT_QUOTA_*`).
 */
export interface QuotaDto {
  maxServers: number | null;
  maxMemoryMb: number | null;
  maxCpuMillis: number | null;
  maxDiskMb: number | null;
  maxBackups: number | null;
}

/**
 * The quota with defaults applied, and what the user uses now (M5). Usage is over the user's own servers (not
 * `deleting`): memory and CPU include stack service limits, disk is the sum of the servers' `diskMb` limits, backups
 * are the non-failed backups of those servers.
 */
export interface EffectiveQuotaDto {
  userId: number;
  /**
   * Admins: nothing is enforced. `limits` still shows what would apply.
   */
  exempt: boolean;
  limits: { [K in keyof QuotaDto]: number };
  used: { servers: number; memoryMb: number; cpuMillis: number; diskMb: number; backups: number };
  overrides: QuotaDto; // The user's own values; null = default.
}

/**
 * `PUT /api/users/:id/quota`. Absent = unchanged, null = back to the panel default, else a whole number 0 … 2^31-1.
 */
export type UpdateQuotaBody = Partial<QuotaDto>;
