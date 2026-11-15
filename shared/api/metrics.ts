/**
 * `GET /api/servers/:id/metrics` (M4): the panel's in-memory history (about the last hour, one sample every
 * STATS_INTERVAL_SEC while the game runs; nothing is stored in the database, so a panel restart starts empty) and the
 * players online. Access: owner, SERVERS_MANAGE_ALL, or any share. Live: `server.stats` and `server.players` on the
 * `server:<id>` topic.
 */

/**
 * One sample, with network counters already turned into rates. Stacks are summed (game + running services); network
 * is the game container's.
 */
export interface MetricSampleDto {
  at: string;
  cpuPercent: number; // 100 = one CPU.
  memoryBytes: number;
  memoryLimitBytes: number;
  netRxBytesPerSec: number; // 0 for the first sample after a (re)start.
  netTxBytesPerSec: number;
  pids: number;
}

export interface ServerMetricsResponse {
  samples: MetricSampleDto[]; // Oldest first, at most LIMITS.METRICS_HISTORY_SAMPLES.
  /**
   * data/ + services/ from the last sample that carried it (about once a minute); null until then.
   */
  disk: { bytes: number; limitBytes: number; measuredAt: string } | null;
  players: string[]; // Online now, in join order.
  /**
   * The definition has `players` patterns; false = the game can't report players (show nothing, not "0 online").
   */
  playersSupported: boolean;
}
