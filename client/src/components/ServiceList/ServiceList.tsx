import { Badge, List, ListItem } from "@ionnet/iontronic/react";
import { Container } from "@ionnet/iontronic/icons";
import type { ServiceState, ServiceStatus } from "@shared/protocol/protocol.gen.ts";

type BadgeTone = "ok" | "warn" | "bad" | "info" | "neutral";

const STATES: Record<ServiceState, { label: string; tone: BadgeTone }> = {
  missing: { label: "Not created", tone: "neutral" },
  created: { label: "Created", tone: "neutral" },
  starting: { label: "Starting", tone: "warn" },
  healthy: { label: "Healthy", tone: "ok" },
  unhealthy: { label: "Unhealthy", tone: "bad" },
  running: { label: "Running", tone: "ok" },
  exited: { label: "Stopped", tone: "neutral" },
};

export interface ServiceStateBadgeProps {
  service: Pick<ServiceStatus, "state" | "exitCode">;
}

/**
 * The state pill of a stack service. A service that exited with a non-zero code reads as a failure.
 */
export function ServiceStateBadge(props: ServiceStateBadgeProps) {
  const { service } = props;
  const entry = STATES[service.state];
  const failed = service.state === "exited" && service.exitCode !== null && service.exitCode !== 0;
  return <Badge tone={failed ? "bad" : entry.tone} size="sm">{failed ? "Failed" : entry.label}</Badge>;
}

export interface ServiceListProps {
  services: ServiceStatus[];
}

/**
 * The extra containers of a stack: name, image, state, and the exit code of one that stopped on its own.
 */
export default function ServiceList(props: ServiceListProps) {
  const { services } = props;
  return (
    <List>
      {services.map((service) => {
        const failed = service.state === "exited" && service.exitCode !== null && service.exitCode !== 0;
        return (
          <ListItem
            key={service.name}
            dense
            icon={Container}
            tone={failed || service.state === "unhealthy" ? "bad" : service.state === "healthy" || service.state === "running" ? "ok" : "neutral"}
            title={<span className="io-mono">{service.name}</span>}
            badges={<ServiceStateBadge service={service} />}
            description={<span className="io-mono">{service.image}</span>}
            meta={service.exitCode !== null && service.state === "exited" ? `Exit code ${service.exitCode}` : undefined}
          />
        );
      })}
    </List>
  );
}
