/**
 * `/api/sources` (SOURCES_MANAGE): git repos of definitions, plus the read-only built-in `builtin` source (games/).
 * Only https URLs; the token (private repos) is write-only.
 */
import type { IsoDate } from "./common.ts";

export type SourceKind = "local" | "git";

export interface SourceDefinitionDto {
  definitionId: number; // The active version.
  gameId: string;
  name: string;
  commit: string;
  serverCount: number; // Servers pinned to any version of this game from this source.
}

export interface SourceDto {
  id: number;
  name: string;
  kind: SourceKind;
  url: string; // git: https URL; local: the folder.
  branch: string;
  path: string; // Subfolder holding the game folders; "" = repo root.
  enabled: boolean;
  hasToken: boolean;
  syncIntervalMin: number | null; // null = SOURCE_SYNC_INTERVAL_MIN.
  syncing: boolean; // A sync is running now.
  lastSyncAt: IsoDate | null;
  lastCommit: string | null;
  lastError: string | null; // Source-level failure (clone, fetch, limits).
  /**
   * gameId → validation error of the last sync. That game's previous version (if any) stays active.
   */
  definitionErrors: Record<string, string>;
  definitions: SourceDefinitionDto[];
  createdAt: IsoDate;
}

export interface CreateSourceBody {
  name: string; // ^[a-z0-9][a-z0-9-]{0,62}$, not "builtin".
  url: string; // https://… only.
  branch?: string; // Default "main".
  path?: string; // Default "".
  token?: string | null;
  syncIntervalMin?: number | null;
}

/**
 * The built-in source accepts only `enabled`. `token: null` clears it; omitted keeps it, except that a `url` on
 * another host clears it (the token isn't sent to a host it wasn't made for).
 */
export interface UpdateSourceBody {
  name?: string;
  url?: string;
  branch?: string;
  path?: string;
  token?: string | null;
  syncIntervalMin?: number | null;
  enabled?: boolean;
}

/**
 * `POST /api/sources/:id/sync` answers when the sync finished (it is bounded by SOURCE_GIT_TIMEOUT_SEC).
 */
export interface SyncSourceResponse {
  source: SourceDto;
  synced: string[]; // gameIds now active at this commit.
  failed: Record<string, string>;
}
