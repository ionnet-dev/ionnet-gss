/**
 * `/api/servers`: game servers. Access: the owner and SERVERS_MANAGE_ALL hold `owner`; shared users hold their
 * share's role (M5). Settings can change only while the server is stopped (409 otherwise); they apply at the next
 * start.
 */
import type { IsoDate } from "./common.ts";
import type { ConsoleLine, InstallProgress, PortProto, ServerState, ServiceStatus, VariableType } from "../protocol/protocol.gen.ts";

export type VariableValue = string | number | boolean;

//#region Sharing (M5)
/**
 * Role of a share: view (console, stats) < operate (+ start/stop/restart, console input) < manage (+ settings,
 * files, backups, upgrades).
 */
export type ServerShareRole = "view" | "operate" | "manage";

/**
 * What the caller holds on a server. `owner` (the owner or SERVERS_MANAGE_ALL) adds delete and sharing.
 */
export type ServerAccessLevel = ServerShareRole | "owner";

export interface ServerShareDto {
  userId: number;
  username: string;
  displayName: string | null;
  role: ServerShareRole;
  createdAt: IsoDate;
}

export interface CreateShareBody {
  username: string;
  role: ServerShareRole;
}

export interface UpdateShareBody {
  role: ServerShareRole;
}
//#endregion

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
  /**
   * The server may open connections to private networks, link-local addresses and the host. false = only the public
   * internet (the host's agent filters the rest and won't start the server when it can't).
   */
  allowPrivateNetwork: boolean;
  /**
   * The caller's level on this server (M5). The client hides or disables what the level doesn't allow.
   */
  access: ServerAccessLevel;
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
  min: number | null; // `number` only: accepted range.
  max: number | null;
  reinstall: boolean; // Changing it re-runs install at the next start.
  adminOnly: boolean;
  /**
   * The value. Always null for `secret`; see `isSet`.
   */
  value: VariableValue | null;
  isSet: boolean;
  /**
   * true = the choices come from the definition's `options_from`; fetch them for this server's pinned definition.
   */
  optionsFrom: boolean;
  /**
   * The variables the `options_from` list depends on: refetch it with their current values when they change.
   */
  optionsDependOn: string[];
  /**
   * Shown only while each named variable holds one of the listed values. null = always.
   */
  when: Record<string, string[]> | null;
  pattern: string | null; // Regular expression a free-text value must match. null = none.
}

export interface GameServerDetailResponse extends GameServerDto {
  variables: ServerVariableDto[]; // admin_only ones only for admins.
  /**
   * A newer active version of the definition exists (same source and game id, different row). Apply it with
   * `POST /api/servers/:id/upgrade` while stopped.
   */
  updateAvailable: boolean;
  /**
   * The version `upgrade` would move to; null when up to date.
   */
  latestDefinition: { id: number; commit: string; syncedAt: IsoDate } | null;
  /**
   * The definition's source (name, kind).
   */
  source: { name: string; kind: "local" | "git" };
  /**
   * Stack services and their last known state (M3); empty for single-container games.
   */
  services: ServiceStatus[];
  /**
   * The definition has `steamcmd` steps or an `update` hook, so `POST /api/servers/:id/update` applies.
   */
  canUpdateGame: boolean;
  /**
   * The game was installed at least once. `update` also runs from `install_failed` when this is true (a failed
   * update can be retried).
   */
  installed: boolean;
  /**
   * The definition has a `settings` block, so the Game settings tab (`/api/servers/:id/game-settings`) applies.
   */
  hasGameSettings: boolean;
}

/**
 * `POST /api/servers/:id/upgrade`. Stopped only (409). Re-resolves the variables against the new version (new keys
 * get defaults/generated secrets, removed keys are dropped, `variables` replace kept values, invalid values → 400
 * naming them) and re-provisions, with `reinstall` when the resolved install steps or a `reinstall` variable changed.
 */
export interface UpgradeServerBody {
  definitionId?: number; // Default: the latest active version of the same source and game.
  /**
   * Replacement values by key, merged over the kept ones: for a kept value the new version rejects (the 400 names
   * it as `"Label" (key)`). Same rules as `UpdateServerBody.variables`.
   */
  variables?: Record<string, VariableValue>;
}

export interface UpgradeServerResponse {
  server: GameServerDetailResponse;
  reinstall: boolean; // Install ran (or will run at the agent) because of the upgrade.
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
  allowPrivateNetwork?: boolean; // SERVERS_PRIVATE_NETWORK only (403 otherwise). Default false.
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
  allowPrivateNetwork?: boolean; // SERVERS_PRIVATE_NETWORK only (403 otherwise).
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
 * `GET /api/servers/:id/console?limit=200&before=<seq>` (max 1000 lines, and at most 1 MiB: the agent cuts long
 * answers). The client subscribes to `server:<id>` first, then fetches this and drops live lines with `seq` ≤ the
 * last backlog line. `before` pages back from the first `seq` of the previous page.
 */
export interface ConsoleBacklogResponse {
  lines: ConsoleLine[];
  more: boolean; // Older lines exist: fetch again with before = lines[0].seq.
}
