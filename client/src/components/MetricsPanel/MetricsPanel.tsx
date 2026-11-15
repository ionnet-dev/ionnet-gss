import { Card, CardBody, CardHeader } from "@ionnet/iontronic/react";
import type { GameServerDto } from "@shared/api/servers.ts";

export interface MetricsPanelProps {
  server: GameServerDto;
}

/**
 * Overview charts (M4): CPU %, memory (used/limit), network rx/tx per second over the last hour from
 * `MetricsApi.useLiveMetrics`, plus disk used/limit (`Meter`). Iontronic has no chart, so `MetricChart` (this
 * folder) is a small SVG line chart coloured with `--io-*` variables (a candidate for Iontronic). An empty state
 * while the game isn't running and no history exists.
 */
export default function MetricsPanel(props: MetricsPanelProps) {
  const { server } = props;
  // TODO(builder)
  return (
    <Card>
      <CardHeader title="Usage" description={`Live usage of ${server.name} isn't built yet.`} />
      <CardBody>{null}</CardBody>
    </Card>
  );
}
