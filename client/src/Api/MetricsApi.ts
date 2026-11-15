import type { MetricSampleDto, ServerMetricsResponse } from "@shared/api/metrics.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/servers/:id/metrics` (M4) and the live `server.stats` / `server.players` events (topic `server:<id>`).
 */
export namespace MetricsApi {
  export function get(serverId: string): Promise<ServerMetricsResponse> {
    return BaseApi.GET(`/servers/${serverId}/metrics`);
  }

  export interface LiveMetrics {
    samples: MetricSampleDto[]; // Oldest first, at most LIMITS.METRICS_HISTORY_SAMPLES.
    disk: ServerMetricsResponse["disk"];
    players: string[];
    playersSupported: boolean;
    loading: boolean;
    error: Error | null;
  }

  /**
   * History + live samples and players: subscribe to `server:<id>` first, then fetch, then append `server.stats`
   * samples newer than the last one (trim to the history size) and replace the players on `server.players`.
   */
  export function useLiveMetrics(serverId: string): LiveMetrics {
    // TODO(builder)
    return { samples: [], disk: null, players: [], playersSupported: false, loading: false, error: null };
  }
}

export default MetricsApi;
