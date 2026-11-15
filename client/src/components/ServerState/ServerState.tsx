import { Badge, Progress } from "@ionnet/iontronic/react";
import type { InstallProgress, ServerState } from "@shared/protocol/protocol.gen.ts";

type BadgeTone = "ok" | "warn" | "bad" | "info" | "neutral";

const STATES: Record<ServerState, { label: string; tone: BadgeTone }> = {
  creating: { label: "Creating", tone: "info" },
  deleting: { label: "Deleting", tone: "warn" },
  installing: { label: "Installing", tone: "info" },
  install_failed: { label: "Install failed", tone: "bad" },
  stopped: { label: "Stopped", tone: "neutral" },
  starting: { label: "Starting", tone: "warn" },
  running: { label: "Running", tone: "ok" },
  stopping: { label: "Stopping", tone: "warn" },
  crashed: { label: "Crashed", tone: "bad" },
};

/**
 * `2/3 · download`: where an install is.
 */
export function describeProgress(progress: InstallProgress | null): string | null {
  if (!progress) return null;
  return `${progress.step}/${progress.total} · ${progress.name}`;
}

/**
 * The states where an operation is in flight and the server can't take a new one.
 */
export function isTransitioning(state: ServerState): boolean {
  return state === "creating" || state === "installing" || state === "starting" || state === "stopping" || state === "deleting";
}

export interface ServerStateBadgeProps {
  state: ServerState;
  progress?: InstallProgress | null;
}

/**
 * The state pill; while installing it carries the step, e.g. `Installing 2/3`.
 */
export default function ServerStateBadge(props: ServerStateBadgeProps) {
  const { state, progress = null } = props;
  const entry = STATES[state];
  const label = state === "installing" && progress ? `${entry.label} ${progress.step}/${progress.total}` : entry.label;
  return <Badge tone={entry.tone} size="sm">{label}</Badge>;
}

export interface InstallProgressBarProps {
  progress: InstallProgress | null;
}

/**
 * Bar for the running install step. Indeterminate until the agent reports the first step.
 */
export function InstallProgressBar(props: InstallProgressBarProps) {
  const { progress } = props;
  if (!progress) return <Progress value={null} label="Preparing the install" />;
  return (
    <Progress
      value={progress.step - 1}
      max={progress.total}
      label={`Step ${progress.step} of ${progress.total}: ${progress.name}`}
      aria-label="Install progress"
    />
  );
}
