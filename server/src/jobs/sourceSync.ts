/**
 * Background sync of git sources (M3): every minute, sync each enabled git source whose interval
 * (`syncIntervalMin ?? SOURCE_SYNC_INTERVAL_MIN`, 0 = manual) has passed since `lastSyncAt`. One sync at a time per
 * source (shared lock with `POST /api/sources/:id/sync` in `DefinitionSync`), at most 2 at once overall.
 * @returns A stop function for shutdown.
 */
export function startSourceSync(): () => void {
  // TODO(builder): C
  return () => {};
}
