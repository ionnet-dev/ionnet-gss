import { type ReactNode, useState } from "react";
import { AlertDialog, Badge, Button, Card, CardBody, CardHeader, Grid, Menu, Spinner, Stack, Tabs } from "@ionnet/iontronic/react";
import { ArrowLeft, Ellipsis, Hammer, Play, RotateCw, Settings, Square, SquareTerminal, TriangleAlert, Zap } from "@ionnet/iontronic/icons";
import type { GameServerDetailResponse } from "@shared/api/servers.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import Console from "@/components/Console/Console.tsx";
import CopyButton from "@/components/CopyButton/CopyButton.tsx";
import { formatBytes, formatAgo } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import ServerSettings from "@/components/ServerSettings/ServerSettings.tsx";
import ServerStateBadge, { InstallProgressBar } from "@/components/ServerState/ServerState.tsx";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

type ServerAction = "start" | "stop" | "kill" | "restart" | "reinstall";

/**
 * `/servers/<uuid>`: one server with its live state, the actions its state allows, the console and the settings.
 * `server.state` events change the header in place; `server.updated` refetches.
 */
export default function ServerDetail(props: Props) {
  const { match } = props;
  const serverId = match.params[0];
  const resource = ServerApi.useServer(serverId);
  const patches = ServerApi.useStatePatches(serverId);
  const [tab, setTab] = useState("console");
  const server = resource.data ? ServerApi.applyState(resource.data, patches[serverId]) : null;

  const back = <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate("/servers")}>Servers</Button>;

  if (!server) {
    return (
      <Stack gap="16">
        <PageHeader title="Server" leading={back} />
        <Card>
          <CardBody>
            {resource.error
              ? <LoadError title="Couldn't load this server" error={resource.error} onRetry={resource.reload} />
              : <Stack align="center"><Spinner label="Loading server" /></Stack>}
          </CardBody>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap="16">
      <PageHeader
        title={server.name}
        leading={back}
        description={
          <Stack direction="row" gap="8" align="center" wrap>
            <ServerStateBadge state={server.state} progress={server.installProgress} />
            <span>{server.definition.name} on {server.host.name}</span>
            {!server.host.online && <Badge tone="warn" size="sm">Host offline</Badge>}
          </Stack>
        }
        actions={<Actions server={server} onChanged={resource.reload} />}
      />
      <Status server={server} onChanged={resource.reload} />
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))}>
        <Tabs.List>
          <Tabs.Tab value="console" icon={SquareTerminal}>Console</Tabs.Tab>
          <Tabs.Tab value="settings" icon={Settings}>Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="console">
          <Card>
            <CardBody>
              <Console serverId={server.id} canSend={server.state === "running"} />
            </CardBody>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <ServerSettings server={server} onChanged={resource.reload} />
        </Tabs.Panel>
      </Tabs.Root>
    </Stack>
  );
}

/**
 * Start, Stop and Restart enabled by state, plus a menu for Kill and Reinstall.
 */
function Actions(props: { server: GameServerDetailResponse; onChanged: () => Promise<void> }) {
  const { server, onChanged } = props;
  const notify = useNotify();
  const [pending, setPending] = useState<ServerAction | null>(null);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);

  const { state } = server;
  const online = server.host.online;
  const canStart = online && (state === "stopped" || state === "crashed");
  const canStop = state === "running" || state === "starting" || state === "installing"; // Stopping an install cancels it.
  const canRestart = online && state === "running";
  const canKill = state === "running" || state === "starting" || state === "stopping";
  const canReinstall = online && (state === "stopped" || state === "crashed" || state === "install_failed");

  const run = async (action: ServerAction, doneTitle: string) => {
    setPending(action);
    try {
      if (action === "start") await ServerApi.start(server.id);
      else if (action === "stop") await ServerApi.stop(server.id);
      else if (action === "kill") await ServerApi.stop(server.id, { kill: true });
      else if (action === "restart") await ServerApi.restart(server.id);
      else await ServerApi.reinstall(server.id);
      await onChanged();
      notify.ok(doneTitle);
    } catch (error) {
      notify.error(error, `Couldn't ${action === "kill" ? "kill" : action} the server`);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <Button variant="primary" icon={Play} disabled={!canStart || pending !== null} loading={pending === "start"} onClick={() => run("start", "Starting the server")}>Start</Button>
      <Button icon={Square} disabled={!canStop || pending !== null} loading={pending === "stop"} onClick={() => run("stop", "Stopping the server")}>Stop</Button>
      <Button icon={RotateCw} disabled={!canRestart || pending !== null} loading={pending === "restart"} onClick={() => run("restart", "Restarting the server")}>Restart</Button>
      <Menu.Root>
        <Menu.Trigger iconOnly icon={Ellipsis} variant="ghost" aria-label="More actions" />
        <Menu.Content align="end">
          <Menu.Item icon={Zap} tone="bad" disabled={!canKill} onClick={() => setKillOpen(true)}>Kill</Menu.Item>
          <Menu.Item icon={Hammer} disabled={!canReinstall} onClick={() => setReinstallOpen(true)}>Reinstall</Menu.Item>
        </Menu.Content>
      </Menu.Root>
      <AlertDialog.Root open={killOpen} onOpenChange={setKillOpen}>
        <AlertDialog.Content title={`Kill ${server.name}?`} description="The game process is ended immediately, without saving. Use Stop unless the server isn't responding.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => run("kill", "Server killed")}>Kill</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root open={reinstallOpen} onOpenChange={setReinstallOpen}>
        <AlertDialog.Content title={`Reinstall ${server.name}?`} description="The install runs again. The world and other files stay, but files the installer manages are replaced.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => run("reinstall", "Reinstalling the server")}>Reinstall</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function Fact(props: { label: string; children: ReactNode }) {
  const { label, children } = props;
  return (
    <Stack gap="4">
      <span className="io-label">{label}</span>
      <span>{children}</span>
    </Stack>
  );
}

/**
 * Address with copy, the limits, and what's going on: install progress, or why it failed or crashed.
 */
function Status(props: { server: GameServerDetailResponse; onChanged: () => Promise<void> }) {
  const { server, onChanged } = props;
  const notify = useNotify();
  const [retrying, setRetrying] = useState(false);
  const installing = server.state === "installing" || server.state === "creating";
  const failed = server.state === "install_failed" || server.state === "crashed";

  const retry = async () => {
    setRetrying(true);
    try {
      await ServerApi.reinstall(server.id);
      await onChanged();
    } catch (error) {
      notify.error(error, "Couldn't retry the install");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Card urgent={failed}>
      <CardHeader title="Overview" description={`Updated ${formatAgo(server.stateChangedAt)}`} />
      <CardBody>
        <Stack gap="16">
          {installing && <InstallProgressBar progress={server.installProgress} />}
          {failed && (
            <Stack direction="row" gap="12" align="start" justify="between" wrap role="alert">
              <Stack direction="row" gap="8" align="start">
                <TriangleAlert size={20} aria-hidden="true" style={{ flex: "none", color: "var(--io-color-hue-text-bad)" }} />
                <Stack gap="4">
                  <strong>{server.state === "install_failed" ? "The install failed" : "The server crashed"}</strong>
                  <span className="io-text-muted">
                    {server.stateReason ?? "No reason was reported."}
                    {server.lastExitCode !== null && ` (exit code ${server.lastExitCode})`}
                  </span>
                </Stack>
              </Stack>
              {server.state === "install_failed" && server.host.online && (
                <Button variant="primary" icon={RotateCw} loading={retrying} onClick={retry}>Retry install</Button>
              )}
            </Stack>
          )}
          <Grid minChildWidth="12rem" gap="16">
            <Fact label="Address">
              {server.address
                ? <Stack direction="row" align="center" gap="4"><span className="io-mono">{server.address}</span><CopyButton text={server.address} label="Copy address" /></Stack>
                : <span className="io-text-muted">Not available yet</span>}
            </Fact>
            <Fact label="Game">{server.definition.name}</Fact>
            <Fact label="Memory"><span className="io-mono">{formatBytes(server.limits.memoryMb * 1024 * 1024)}</span></Fact>
            <Fact label="Owner">{server.owner.username}</Fact>
          </Grid>
        </Stack>
      </CardBody>
    </Card>
  );
}
