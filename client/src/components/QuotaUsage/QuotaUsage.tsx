import type { EffectiveQuotaDto } from "@shared/api/users.ts";

interface Props {
  quota: EffectiveQuotaDto;
  /**
   * One line per limit without the card frame (inside the quota dialog).
   */
  compact?: boolean;
}

/**
 * Used vs limit for each quota field (servers, RAM, CPU, disk, backups) as meters; "No limits (administrator)" when
 * `exempt`. Shown on the account page (own quota, `QuotaApi.useMine`) and in `QuotaDialog`. M5, parcel A.
 */
export default function QuotaUsage(props: Props) {
  // TODO(builder): M5 quota
  return null;
}
