import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import type { LiveEventName, LiveEvents } from "@shared/live.ts";
import { liveSocket } from "@/live/LiveSocket.ts";

export interface ResourceOptions {
  /**
   * Refetch when one of these live events arrives.
   */
  liveEvents?: LiveEventName[];
  /**
   * Narrow `liveEvents` to the ones about this resource. Default: every event refetches.
   */
  liveFilter?: (event: LiveEventName, data: LiveEvents[LiveEventName]) => boolean;
}

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /**
   * Fetch again (after a mutation). Keeps the old data while loading.
   */
  reload: () => Promise<void>;
}

/**
 * Load data with `loader`, again when `deps` change, and again when a matching live event arrives.
 * Used by the `useXxx()` hooks in `Api/`.
 */
export function useResource<T>(loader: () => Promise<T>, deps: DependencyList, opts?: ResourceOptions): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const call = ++latest.current;
    setLoading(true);
    try {
      const result = await loaderRef.current();
      if (call !== latest.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (call !== latest.current) return;
      setError(err as Error);
    }
    finally {
      if (call === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, deps);

  const events = opts?.liveEvents?.join(",") ?? "";
  const filterRef = useRef(opts?.liveFilter);
  filterRef.current = opts?.liveFilter;
  useEffect(() => {
    if (!events) return;
    const offs = (events.split(",") as LiveEventName[]).map((event) =>
      liveSocket.on(event, (eventData) => {
        if (!filterRef.current || filterRef.current(event, eventData)) reload();
      })
    );
    // Events missed while the socket was down: refetch once it is back.
    offs.push(liveSocket.onReconnect(() => reload()));
    return () => offs.forEach((off) => off());
  }, [events, reload]);

  return { data, error, loading, reload };
}
