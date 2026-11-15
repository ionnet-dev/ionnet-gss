import { Badge } from "@ionnet/iontronic/react";
import type { HostDto } from "@shared/api/hosts.ts";

export interface HostStatusProps {
  host: Pick<HostDto, "online" | "disabled">;
}

/**
 * Online / Offline / Disabled pill.
 */
export default function HostStatus(props: HostStatusProps) {
  const { host } = props;
  if (host.disabled) return <Badge tone="warn" size="sm">Disabled</Badge>;
  if (host.online) return <Badge tone="ok" size="sm">Online</Badge>;
  return <Badge tone="neutral" size="sm">Offline</Badge>;
}
