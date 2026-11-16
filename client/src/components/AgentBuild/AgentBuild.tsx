import { Badge } from "@ionnet/iontronic/react";
import type { HostAgentDto } from "@shared/api/hosts.ts";

export interface AgentBuildBadgeProps {
  agent: HostAgentDto;
  /**
   * Hide the badge when the agent is up to date (the host list only flags what needs attention).
   */
  onlyOutdated?: boolean;
}

/**
 * The first 12 hex digits of a build digest, enough to tell two builds apart.
 */
export function shortBuild(build: string): string {
  return build.slice(0, 12);
}

/**
 * Up to date / Update available / Unknown: whether the agent runs the build the panel serves.
 */
export default function AgentBuildBadge(props: AgentBuildBadgeProps) {
  const { agent, onlyOutdated } = props;
  if (agent.upToDate === false) return <Badge tone="warn" size="sm">Update available</Badge>;
  if (onlyOutdated) return null;
  if (agent.upToDate === true) return <Badge tone="ok" size="sm">Up to date</Badge>;
  return <Badge tone="neutral" size="sm">Unknown</Badge>;
}
