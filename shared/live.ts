/**
 * `/ws/live`: the browser's live socket. The panel pushes events; the client refetches what an event names.
 * Browsers can't set headers on a WebSocket, so the first frame carries the bearer token.
 *
 * Client → panel: `auth` first (within 10 s), then `subscribe` / `unsubscribe` for per-server streams (M2).
 * Panel → client: `ready` after auth, then `event` frames.
 */
import type { BackupOperation, ConsoleLine, InstallProgress, ServerState, ServiceStatus } from "./protocol/protocol.gen.ts";
import type { MetricSampleDto } from "./api/metrics.ts";

/**
 * Every live event and its data. A `null` id means "the list changed, refetch it".
 */
export interface LiveEvents {
  //#region M1
  // Host added, edited, removed, or the facts the list shows changed (versions, OS, totals).
  // Audience: HOSTS_MANAGE + users granted the host.
  "host.updated": { hostId: string | null };
  // New usage figures (load, available memory, free disk); at most once a minute per host. Only the host detail page
  // listens. Same audience.
  "host.facts": { hostId: string };
  // Agent connected or went quiet. Same audience.
  "host.status": { hostId: string; online: boolean; lastSeenAt: string | null };
  // Audience: USERS_MANAGE + the user themself.
  "user.updated": { userId: number | null };
  // Audience: INVITES_MANAGE.
  "invite.updated": { inviteId: number | null };
  // Created, deleted or used. Audience: HOSTS_MANAGE.
  "enrolToken.updated": { enrolTokenId: number | null };
  //#endregion

  //#region M2
  // Created, edited or deleted. Audience: owner + SERVERS_MANAGE_ALL.
  "server.updated": { serverId: string | null };
  // Audience: owner + SERVERS_MANAGE_ALL. Clients update in place (no refetch needed).
  "server.state": {
    serverId: string;
    state: ServerState;
    exitCode: number | null;
    reason: string | null;
    installProgress: InstallProgress | null;
    at: string;
  };
  // Audience: subscribers of `server:<id>` only. Subscribing checks access (owner or SERVERS_MANAGE_ALL); a refused
  // subscribe answers `{ t: "error" }`. Backlog comes from `GET /api/servers/:id/console`.
  "server.console": { serverId: string; lines: ConsoleLine[] };
  // M4: one sample every STATS_INTERVAL_SEC while the game runs (rates derived by the panel). Audience: subscribers
  // of `server:<id>` only. Append to the history from `GET /api/servers/:id/metrics`.
  "server.stats": { serverId: string; sample: MetricSampleDto; diskBytes: number | null };
  //#endregion

  //#region M3
  // Created, edited, deleted, sync started or finished. Audience: SOURCES_MANAGE.
  "source.updated": { sourceId: number | null; syncing: boolean };
  // A sync changed the active definitions (new game, new version). Audience: everyone signed in (the create form
  // and "update available" refetch).
  "definitions.updated": { sourceId: number };
  // Stack service states changed. Audience: owner + SERVERS_MANAGE_ALL. Apply in place.
  "server.services": { serverId: string; services: ServiceStatus[] };
  //#endregion

  //#region M4
  // The whole current list after every join, leave or reset (game stopped). Audience: subscribers of `server:<id>`.
  "server.players": { serverId: string; players: string[] };
  // A backup was created, finished, failed, deleted or restored (refetch the list). Audience: owner +
  // SERVERS_MANAGE_ALL.
  "backup.updated": { serverId: string; backupId: number | null };
  // Progress of the running backup or restore, at most every BACKUP_PROGRESS_INTERVAL_SEC. Audience: subscribers of
  // `server:<id>`. Apply in place.
  "backup.progress": { serverId: string; backupId: number; operation: BackupOperation; bytes: number; totalBytes: number | null };
  //#endregion
}

export type LiveEventName = keyof LiveEvents;

/**
 * Stream topics a client can subscribe to (M2): `server:<uuid>` carries `server.console`, `server.stats`, and since M4
 * `server.players` and `backup.progress`.
 */
export type LiveTopic = `server:${string}`;

export type LiveClientFrame =
  | { t: "auth"; token: string }
  | { t: "subscribe"; topic: LiveTopic }
  | { t: "unsubscribe"; topic: LiveTopic };

export type LiveServerFrame =
  | { t: "ready"; userId: number }
  | { t: "subscribed"; topic: LiveTopic } // M2: the subscribe was accepted; fetch the backlog now.
  | { t: "error"; message: string; topic?: LiveTopic } // `topic` set when a subscribe was refused.
  | { [E in LiveEventName]: { t: "event"; event: E; data: LiveEvents[E] } }[LiveEventName];

/**
 * Seconds the panel waits for the `auth` frame.
 */
export const LIVE_AUTH_TIMEOUT_SEC = 10;
