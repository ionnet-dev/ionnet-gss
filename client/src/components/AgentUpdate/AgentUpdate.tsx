import { useState } from "react";
import { Button, Card, CardBody, CardHeader, CodeBlock, Grid, Stack, Switch } from "@ionnet/iontronic/react";
import { RefreshCw } from "@ionnet/iontronic/icons";
import type { HostDetailResponse } from "@shared/api/hosts.ts";
import type { AgentUpdateStatus } from "@shared/protocol/protocol.gen.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import { HostApi } from "@/Api/HostApi.ts";
import AgentBuildBadge, { shortBuild } from "@/components/AgentBuild/AgentBuild.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { useResource } from "@/hooks/useResource.ts";

export interface AgentUpdateProps {
  host: HostDetailResponse;
  onChanged: () => Promise<void>;
}

/**
 * The status line for an update's progress, or null when none is shown.
 */
function describeUpdate(update: AgentUpdateStatus | null): { text: string; failed: boolean } | null {
  switch (update?.state) {
    case "downloading": return { text: "Downloading the new agent…", failed: false };
    case "waiting": return { text: update.waitingFor.length > 0 ? `Waiting for: ${update.waitingFor.join(", ")}` : "Waiting for running operations to finish…", failed: false };
    case "restarting": return { text: "Restarting into the new agent…", failed: false };
    case "failed": return { text: `Failed: ${update.message || "the agent gave no reason."}`, failed: true };
    default: return null;
  }
}

/**
 * Agent card of the host page (HOSTS_MANAGE): running build against the panel's build, the update's progress, the
 * "Update agent" button and the automatic-update switch.
 */
export default function AgentUpdate(props: AgentUpdateProps) {
  const { host, onChanged } = props;
  const { agent } = host;
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const meta = useResource(() => AuthApi.getMeta(), []);
  const progress = describeUpdate(agent.update);
  const inFlight = agent.update !== null && ["downloading", "waiting", "restarting"].includes(agent.update.state);
  const noBuild = agent.latestBuild === null;

  const update = async () => {
    setBusy(true);
    try {
      await HostApi.updateAgent(host.id);
      await onChanged();
      notify.ok("Agent update started");
    } catch (error) {
      notify.error(error, "Couldn't update the agent");
    } finally {
      setBusy(false);
    }
  };

  const setAutoUpdate = async (autoUpdateAgent: boolean) => {
    try {
      await HostApi.update(host.id, { autoUpdateAgent });
      await onChanged();
    } catch (error) {
      notify.error(error, "Couldn't change the automatic update");
    }
  };

  return (
    <Card>
      <CardHeader title="Agent" description="The gss-agent program on this host." actions={<AgentBuildBadge agent={agent} />} />
      <CardBody>
        <Stack gap="16">
          <Grid minChildWidth="16rem" gap="16">
            <Stack gap="4">
              <span className="io-label">Running build</span>
              <span className="io-mono">{agent.build ? shortBuild(agent.build) : "Unknown"}</span>
            </Stack>
            <Stack gap="4">
              <span className="io-label">Panel build</span>
              <span className="io-mono">{agent.latestBuild ? shortBuild(agent.latestBuild) : "None for this host's architecture"}</span>
            </Stack>
          </Grid>
          {progress && <span role="status" style={{ color: progress.failed ? "var(--io-color-hue-text-danger)" : undefined }}>{progress.text}</span>}
          {agent.build === null && host.facts && (
            <Stack gap="8">
              <span>
                This agent didn't report its build. Agents older than the update feature can't be updated from the panel: run this on the host once, and later updates work from here.
              </span>
              <CodeBlock code={`curl -fsSL ${meta.data?.publicUrl ?? ""}/api/agent/install.sh | sudo bash`} language="bash" wrap copyLabel="Copy install command" />
            </Stack>
          )}
          <Stack direction="row" gap="8" align="center" wrap>
            <Button icon={RefreshCw} loading={busy} disabled={!host.online || agent.upToDate === true || inFlight || noBuild} onClick={update}>Update agent</Button>
            {!host.online && <span>The host is offline.</span>}
          </Stack>
          <Switch
            label="Update automatically"
            description="Updates the agent when the panel is upgraded. It waits for installs and backups to finish, and game servers keep running."
            checked={host.agent.autoUpdate}
            onCheckedChange={setAutoUpdate}
          />
        </Stack>
      </CardBody>
    </Card>
  );
}
