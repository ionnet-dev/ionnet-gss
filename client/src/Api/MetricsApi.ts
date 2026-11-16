import { useEffect, useMemo, useState } from "react";
import type { MetricSampleDto, ServerMetricsResponse } from "@shared/api/metrics.ts";
import { LIMITS } from "@shared/constants.ts";
import { useResource } from "@/hooks/useResource.ts";
import { liveSocket } from "@/live/LiveSocket.ts";
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
    reload: () => Promise<void>;
  }

  interface Fetched {
    response: ServerMetricsResponse;
    startedAt: number; // When the request left; live events after it are newer than (or part of) the answer.
  }

  interface Overlay {
    samples: MetricSampleDto[];
    players: { list: string[]; at: number } | null;
    disk: { bytes: number; at: number } | null;
  }

  const EMPTY_OVERLAY: Overlay = { samples: [], players: null, disk: null };

  /**
   * History + live samples and players: subscribe to `server:<id>` first, then fetch (again once the panel confirms
   * the subscription), then append `server.stats` samples newer than the last one (trimmed to the history size) and
   * replace the players on `server.players`.
   */
  export function useLiveMetrics(serverId: string): LiveMetrics {
    const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
    const resource = useResource<Fetched>(async () => {
      const startedAt = Date.now();
      return { response: await get(serverId), startedAt };
    }, [serverId]);
    const { reload } = resource;

    useEffect(() => {
      setOverlay(EMPTY_OVERLAY);
      const offStats = liveSocket.on("server.stats", (event) => {
        if (event.serverId !== serverId) return;
        setOverlay((current) => ({
          ...current,
          samples: [...current.samples, event.sample].slice(-LIMITS.METRICS_HISTORY_SAMPLES),
          disk: event.diskBytes === null ? current.disk : { bytes: event.diskBytes, at: Date.now() },
        }));
      });
      const offPlayers = liveSocket.on("server.players", (event) => {
        if (event.serverId !== serverId) return;
        setOverlay((current) => ({ ...current, players: { list: event.players, at: Date.now() } }));
      });
      const offTopic = liveSocket.subscribeTopic(`server:${serverId}`, { onSubscribed: () => void reload() });
      return () => {
        offStats();
        offPlayers();
        offTopic();
      };
    }, [serverId, reload]);

    const fetched = resource.data;
    const base = fetched?.response;
    const needsLimit = base !== undefined && base.disk === null && overlay.disk !== null;
    useEffect(() => {
      if (needsLimit) void reload(); // A first disk figure arrived live; the limit comes with the next fetch.
    }, [needsLimit, reload]);

    return useMemo<LiveMetrics>(() => {
      if (!fetched || !base) {
        return { samples: [], disk: null, players: [], playersSupported: false, loading: resource.loading, error: resource.error, reload };
      }
      const lastAt = base.samples.length > 0 ? Date.parse(base.samples[base.samples.length - 1].at) : 0;
      const fresh = overlay.samples.filter((sample) => Date.parse(sample.at) > lastAt);
      const liveDisk = overlay.disk && overlay.disk.at >= fetched.startedAt ? overlay.disk : null;
      const livePlayers = overlay.players && overlay.players.at >= fetched.startedAt ? overlay.players.list : null;
      return {
        samples: [...base.samples, ...fresh].slice(-LIMITS.METRICS_HISTORY_SAMPLES),
        disk: base.disk ? (liveDisk ? { ...base.disk, bytes: liveDisk.bytes, measuredAt: new Date(liveDisk.at).toISOString() } : base.disk) : null,
        players: livePlayers ?? base.players,
        playersSupported: base.playersSupported,
        loading: false,
        error: resource.error,
        reload,
      };
    }, [fetched, base, overlay, resource.loading, resource.error, reload]);
  }
}

export default MetricsApi;
