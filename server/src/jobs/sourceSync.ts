import { Config } from "../Config.ts";
import { DefinitionSync } from "../definitions/DefinitionSync.ts";
import { Source } from "../models/index.ts";

const TICK_MS = 60_000;
const MAX_CONCURRENT = 2;

/**
 * Background sync of git sources (M3): every minute, sync each enabled git source whose interval
 * (`syncIntervalMin ?? SOURCE_SYNC_INTERVAL_MIN`, 0 = manual) has passed since `lastSyncAt`. One sync at a time per
 * source (shared lock with `POST /api/sources/:id/sync` in `DefinitionSync`), at most 2 at once overall.
 * @returns A stop function for shutdown.
 */
export function startSourceSync(): () => void {
  let stopped = false;
  let ticking = false;
  const active = new Set<number>();

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const sources = await Source.findAll({ where: { kind: "git", enabled: true } });
      const now = Date.now();
      for (const source of sources) {
        if (stopped) break;
        if (active.size >= MAX_CONCURRENT) break; // The rest wait for the next tick.
        const interval = source.syncIntervalMin ?? Config.SOURCE_SYNC_INTERVAL_MIN;
        if (interval === 0 || DefinitionSync.isSyncing(source.id) || active.has(source.id)) continue;
        if (source.lastSyncAt !== null && now - source.lastSyncAt.getTime() < interval * 60_000) continue;
        active.add(source.id);
        DefinitionSync.syncSource(source)
          .catch((error) => console.warn(`sources: the scheduled sync of "${source.name}" failed: ${(error as Error).message}`))
          .finally(() => active.delete(source.id));
      }
    } catch (error) {
      console.error("sources: the sync scheduler failed", error);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5_000); // A panel that was down for a while catches up soon after it starts.
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
