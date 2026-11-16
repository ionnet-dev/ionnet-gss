import { useMemo } from "react";
import { Card, CardBody, CardHeader, EmptyState, Meter, Spinner, Stack } from "@ionnet/iontronic/react";
import { Activity } from "@ionnet/iontronic/icons";
import type { GameServerDto } from "@shared/api/servers.ts";
import { MetricsApi } from "@/Api/MetricsApi.ts";
import { formatBytes } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import PlayerList from "@/components/PlayerList/PlayerList.tsx";
import MetricChart from "./MetricChart.tsx";
import "./MetricsPanel.scss";

export interface MetricsPanelProps {
  server: GameServerDto;
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Overview charts (M4): CPU %, memory (used/limit), network rx/tx per second over the last hour from
 * `MetricsApi.useLiveMetrics`, plus disk used/limit (`Meter`) and the players online. Iontronic has no chart, so
 * `MetricChart` (this folder) is a small SVG line chart coloured with `--io-*` variables (a candidate for Iontronic).
 * An empty state while the game isn't running and no history exists.
 */
export default function MetricsPanel(props: MetricsPanelProps) {
  const { server } = props;
  const metrics = MetricsApi.useLiveMetrics(server.id);
  const { samples, disk } = metrics;

  const data = useMemo(() => ({
    times: samples.map((sample) => Date.parse(sample.at)),
    cpu: samples.map((sample) => sample.cpuPercent),
    memory: samples.map((sample) => sample.memoryBytes),
    memoryLimit: samples.map((sample) => sample.memoryLimitBytes),
    rx: samples.map((sample) => sample.netRxBytesPerSec),
    tx: samples.map((sample) => sample.netTxBytesPerSec),
  }), [samples]);

  if (metrics.error && samples.length === 0) {
    return <LoadError title="Couldn't load usage" error={metrics.error} onRetry={metrics.reload} />;
  }

  const running = server.state === "starting" || server.state === "running";

  return (
    <Stack gap="16">
      <Card>
        <CardHeader title="Usage" description="The last hour, one sample every 5 seconds while the game runs. Stack services count towards CPU and memory." />
        <CardBody>
          {metrics.loading
            ? <Stack align="center"><Spinner label="Loading usage" /></Stack>
            : samples.length === 0
            ? (
              <EmptyState
                icon={Activity}
                tone="neutral"
                size="sm"
                title={running ? "Waiting for the first sample" : "No usage recorded yet"}
                description={running ? "Samples arrive every 5 seconds." : "Usage is recorded while the server runs. The history is kept in memory and starts empty after a panel restart."}
              />
            )
            : (
              <div className="metrics-panel__grid">
                <MetricChart
                  title="CPU"
                  times={data.times}
                  series={[{ label: "Usage", color: "var(--io-color-category-5)", values: data.cpu }]}
                  format={formatPercent}
                  minMax={100}
                />
                <MetricChart
                  title="Memory"
                  times={data.times}
                  series={[
                    { label: "Used", color: "var(--io-color-category-2)", values: data.memory },
                    { label: "Limit", color: "var(--io-color-text-subtle)", values: data.memoryLimit, dashed: true },
                  ]}
                  format={(value) => formatBytes(value)}
                  exactTop
                />
                <MetricChart
                  title="Network"
                  times={data.times}
                  series={[
                    { label: "In", color: "var(--io-color-category-4)", values: data.rx },
                    { label: "Out", color: "var(--io-color-category-1)", values: data.tx },
                  ]}
                  format={formatRate}
                  minMax={1024}
                />
                <div className="metrics-panel__disk">
                  <span className="metrics-panel__disk-title">Disk</span>
                  {disk
                    ? (
                      <Meter
                        value={Math.min(disk.bytes, disk.limitBytes)}
                        max={disk.limitBytes}
                        tone={disk.bytes > disk.limitBytes * 0.9 ? "bad" : disk.bytes > disk.limitBytes * 0.75 ? "warn" : "ok"}
                        aria-label="Disk used"
                        label={`${formatBytes(disk.bytes)} of ${formatBytes(disk.limitBytes)}`}
                      />
                    )
                    : <span className="io-text-muted">Measured about once a minute.</span>}
                  {samples.length > 0 && <span className="io-text-muted metrics-panel__disk-note">{`${samples[samples.length - 1].pids} processes`}</span>}
                </div>
              </div>
            )}
        </CardBody>
      </Card>
      <PlayerList players={metrics.players} supported={metrics.playersSupported} />
    </Stack>
  );
}
