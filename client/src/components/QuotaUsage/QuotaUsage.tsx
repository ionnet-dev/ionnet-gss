import { Badge, Card, CardBody, CardHeader, Grid, Meter, Stack } from "@ionnet/iontronic/react";
import type { EffectiveQuotaDto } from "@shared/api/users.ts";
import { formatBytes } from "@/components/Format/format.ts";

interface Props {
  quota: EffectiveQuotaDto;
  /**
   * One line per limit without the card frame (inside the quota dialog).
   */
  compact?: boolean;
}

type Used = EffectiveQuotaDto["used"];
type Limits = EffectiveQuotaDto["limits"];

/**
 * Each row: its usage key, its limit key, its label, and how a value reads.
 */
const ROWS: { used: keyof Used; limit: keyof Limits; label: string; format: (value: number) => string }[] = [
  { used: "servers", limit: "maxServers", label: "Game servers", format: (value) => `${value}` },
  { used: "memoryMb", limit: "maxMemoryMb", label: "RAM", format: (value) => formatBytes(value * 1048576) },
  { used: "cpuMillis", limit: "maxCpuMillis", label: "CPU", format: formatCpus },
  { used: "diskMb", limit: "maxDiskMb", label: "Disk", format: (value) => formatBytes(value * 1048576) },
  { used: "backups", limit: "maxBackups", label: "Backups", format: (value) => `${value}` },
];

function formatCpus(millis: number): string {
  const value = Number((millis / 1000).toFixed(2));
  return `${value} CPU${value === 1 ? "" : "s"}`;
}

/**
 * Used vs limit for each quota field (servers, RAM, CPU, disk, backups) as meters; "No limits (administrator)" when
 * `exempt`. Shown on the account page (own quota, `QuotaApi.useMine`) and in `QuotaDialog`. M5, parcel A.
 */
export default function QuotaUsage(props: Props) {
  const { quota, compact } = props;

  const meters = (
    <Stack gap={compact ? "12" : "16"}>
      {quota.exempt && <Badge tone="info">No limits (administrator)</Badge>}
      <Grid minChildWidth={compact ? "100%" : "14rem"} gap={compact ? "12" : "20"}>
        {ROWS.map((row) => {
          const used = quota.used[row.used];
          const limit = quota.limits[row.limit];
          if (quota.exempt) {
            return (
              <Meter
                key={row.used}
                size="sm"
                label={row.label}
                showValue
                value={0}
                max={1}
                tone="neutral"
                format={() => `${row.format(used)} used`}
              />
            );
          }
          const ratio = limit === 0 ? (used > 0 ? 2 : 1) : used / limit;
          return (
            <Meter
              key={row.used}
              size={compact ? "sm" : "md"}
              label={row.label}
              showValue
              value={Math.min(used, limit)}
              max={Math.max(limit, 1)}
              tone={ratio > 1 ? "bad" : ratio >= 0.8 ? "warn" : "accent"}
              format={() => `${row.format(used)} of ${row.format(limit)}${used > limit ? " (over)" : ""}`}
              aria-label={`${row.label}: ${row.format(used)} of ${row.format(limit)}`}
            />
          );
        })}
      </Grid>
    </Stack>
  );

  if (compact) return meters;
  return (
    <Card>
      <CardHeader title="Quota" description="What your game servers and backups may use. An administrator sets the limits." />
      <CardBody>{meters}</CardBody>
    </Card>
  );
}
