/**
 * `/api/invites` (INVITES_MANAGE).
 */
import type { IsoDate } from "./common.ts";

export interface InviteDto {
  id: number;
  codeHint: string; // Last characters of the code, to tell invites apart.
  email: string | null;
  role: string;
  createdBy: string | null; // Username.
  usedBy: string | null; // Username.
  expiresAt: IsoDate;
  usedAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface CreateInviteBody {
  email?: string | null;
  role?: string; // Default: "user".
  expiresInHours?: number; // Default: INVITE_TTL_HOURS.
}

/**
 * The code is in the response once; only its hash is stored.
 */
export interface InviteCreatedResponse {
  invite: InviteDto;
  code: string;
  url: string; // `${PUBLIC_URL}/register?code=…`
}
