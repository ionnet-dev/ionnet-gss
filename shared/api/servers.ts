/**
 * `/api/servers`: game servers. Access in M2: the owner, or SERVERS_MANAGE_ALL (admins). Sharing comes later.
 * Settings can change only while the server is stopped (409 otherwise); they apply at the next start.
 */
import type { IsoDate } from "./common.ts";
import type { ConsoleLine, InstallProgress, PortProto, ServerState, VariableType } from "../protocol/protocol.gen.ts";

export type VariableValue = string | number | boolean;

export interface ServerPortDto {
  name: string;
  proto: PortProto;
  port: number;
  pinned: boolean; // Chosen by an admin (PORTS_OVERRIDE).
}

export interface GameServerDto {
  id: string; // UUID
  name: string;
  owner: { id: number; username: string };
  host: { id: string; name: string; online: boolean };
  definition: { id: number; gameId: string; name: string; commit: string };
  state: ServerState;
  stateReason: string | null; // Cause of install_failed / crashed.
  lastExitCode: number | null;
  stateChangedAt: IsoDate;
  installProgress: InstallProgress | null; // Live from the agent while installing; null otherwise.
  ports: ServerPortDto[]; // Published ports only.
  /**
   * What players type: `<host address or hostname>:<port named "game", else the first published port>`. null when
   * nothing is published.
   */
  address: string | null;
  limits: { memoryMb: number; cpuMillis: number; diskMb: number };
  autostart: boolean;
  autoRestart: boolean;
  createdAt: IsoDate;
}

/**
 * One variable with its current value, for the settings tab.
 */
export interface ServerVariableDto {
  key: string;
  label: string; // Falls back to the key.
  description: string | null;
  type: VariableType;
  options: string[] | null; // `select` choices.
  unit: string | null;
  reinstall: boolean; // Changing it re-runs install at the next start.
  adminOnly: boolean;
  /**
   * The value. Always null for `secret`; see `isSet`.
   */
  value: VariableValue | null;
  isSet: boolean;
}

export interface GameServerDetailResponse extends GameServerDto {
  variables: ServerVariableDto[]; // admin_only ones only for admins.
  /**
   * A newer active version of the definition exists (upgrading is M3).
   */
  updateAvailable: boolean;
}

export interface CreateServerBody {
  name: string;
  hostId: string;
  definitionId: number;
  /**
   * By key. Missing keys take the default; secrets with `generate` are generated. `bind` variables set the limits.
   */
  variables?: Record<string, VariableValue>;
  autostart?: boolean; // Default true.
  autoRestart?: boolean; // Default false.
  /**
   * PORTS_OVERRIDE only: port name → number. Must be free on the host (any number, not only the pool).
   */
  ports?: Record<string, number>;
}

export interface UpdateServerBody {
  name?: string;
  variables?: Record<string, VariableValue>; // Only the keys to change; a secret set to "" regenerates it.
  autostart?: boolean;
  autoRestart?: boolean;
}

export interface UpdateServerResponse {
  server: GameServerDetailResponse;
  /**
   * A `reinstall` variable changed: the next start re-runs install.
   */
  reinstallPending: boolean;
}

export interface StopServerBody {
  kill?: boolean; // Skip the graceful stop.
}

export interface ConsoleInputBody {
  line: string;
}

/**
 * `GET /api/servers/:id/console?limit=200` (max 1000). The client subscribes to `server:<id>` first, then fetches
 * this and drops live lines with `seq` ≤ the last backlog line.
 */
export interface ConsoleBacklogResponse {
  lines: ConsoleLine[];
}
