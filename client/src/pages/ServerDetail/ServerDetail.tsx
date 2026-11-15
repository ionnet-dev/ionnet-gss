import { type FormEvent, type ReactNode, useState } from "react";
import { AlertDialog, Badge, Button, Card, CardBody, CardFooter, CardHeader, Dialog, Grid, IconTile, Menu, Spinner, Stack, Tabs } from "@ionnet/iontronic/react";
import { Activity, Archive, ArrowLeft, CircleArrowUp, Download, Ellipsis, FolderOpen, Hammer, Play, RotateCw, Settings, Square, SquareTerminal, TriangleAlert, Zap } from "@ionnet/iontronic/icons";
import type { GameServerDetailResponse } from "@shared/api/servers.ts";
import type { ServerState } from "@shared/protocol/protocol.gen.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { DefinitionApi } from "@/Api/DefinitionApi.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import BackupList from "@/components/BackupList/BackupList.tsx";
import Console from "@/components/Console/Console.tsx";
import FileManager from "@/components/FileManager/FileManager.tsx";
import MetricsPanel from "@/components/MetricsPanel/MetricsPanel.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import CopyButton from "@/components/CopyButton/CopyButton.tsx";
import { formatAgo, formatBytes, formatCommit } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import ServiceList from "@/components/ServiceList/ServiceList.tsx";
import ServerSettings from "@/components/ServerSettings/ServerSettings.tsx";
import ServerStateBadge, { InstallProgressBar } from "@/components/ServerState/ServerState.tsx";
import VariableForm, {
  errorFieldFor,
  type FormErrors,
  type FormValues,
  type FormVariable,
  fromDefinition,
  initialValues,
  toValues,
  useVariableOptions,
  validate,
} from "@/components/VariableForm/VariableForm.tsx";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

type ServerAction = "start" | "stop" | "kill" | "restart" | "reinstall" | "update";

/**
 * `/servers/<uuid>`: one server with its live state, the actions its state allows, the console and the settings.
 * `server.state` events change the header in place; `server.updated` refetches.
 */
export default function ServerDetail(props: Props) {
  const { match } = props;
  const serverId = match.params[0];
  const resource = ServerApi.useServer(serverId);
  const patches = ServerApi.useStatePatches(serverId);
  const [tab, setTab] = useState("overview");
  const server = resource.data ? ServerApi.applyState(resource.data, patches[serverId]) : null;
  const services = ServerApi.useServices(resource.data);

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
      {server.latestDefinition && <UpdateNotice server={server} onChanged={resource.reload} />}
      <Status server={server} onChanged={resource.reload} />
      {services.length > 0 && (
        <Card>
          <CardHeader title="Services" description="Extra containers that run next to the game. They start before it and stop after it." />
          <CardBody>
            <ServiceList services={services} />
          </CardBody>
        </Card>
      )}
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))}>
        <Tabs.List>
          <Tabs.Tab value="overview" icon={Activity}>Overview</Tabs.Tab>
          <Tabs.Tab value="console" icon={SquareTerminal}>Console</Tabs.Tab>
          <Tabs.Tab value="files" icon={FolderOpen}>Files</Tabs.Tab>
          <Tabs.Tab value="backups" icon={Archive}>Backups</Tabs.Tab>
          <Tabs.Tab value="settings" icon={Settings}>Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview">
          <MetricsPanel server={server} />
        </Tabs.Panel>
        <Tabs.Panel value="console">
          <Card>
            <CardBody>
              <Console serverId={server.id} canSend={server.state === "running"} />
            </CardBody>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="files">
          <FileManager server={server} />
        </Tabs.Panel>
        <Tabs.Panel value="backups">
          <BackupList server={server} />
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <ServerSettings server={server} onChanged={resource.reload} />
        </Tabs.Panel>
      </Tabs.Root>
    </Stack>
  );
}

/**
 * Start, Stop and Restart enabled by state, plus a menu for Update game, Kill and Reinstall.
 */
function Actions(props: { server: GameServerDetailResponse; onChanged: () => Promise<void> }) {
  const { server, onChanged } = props;
  const notify = useNotify();
  const [pending, setPending] = useState<ServerAction | null>(null);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  const { state } = server;
  const online = server.host.online;
  const canStart = online && (state === "stopped" || state === "crashed");
  const canStop = state === "running" || state === "starting" || state === "installing"; // Stopping an install cancels it.
  const canRestart = online && state === "running";
  const canKill = state === "running" || state === "starting" || state === "stopping";
  const canReinstall = online && (state === "stopped" || state === "crashed" || state === "install_failed");
  const canUpdate = online && (state === "stopped" || state === "crashed" || (state === "install_failed" && server.installed));

  const run = async (action: ServerAction, doneTitle: string) => {
    setPending(action);
    try {
      if (action === "start") await ServerApi.start(server.id);
      else if (action === "stop") await ServerApi.stop(server.id);
      else if (action === "kill") await ServerApi.stop(server.id, { kill: true });
      else if (action === "update") await ServerApi.updateGame(server.id);
      else if (action === "restart") await ServerApi.restart(server.id);
      else await ServerApi.reinstall(server.id);
      await onChanged();
      notify.ok(doneTitle);
    } catch (error) {
      notify.error(error, action === "update" ? "Couldn't update the game" : `Couldn't ${action} the server`);
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
          {server.canUpdateGame && <Menu.Item icon={Download} disabled={!canUpdate} onClick={() => setUpdateOpen(true)}>Update game</Menu.Item>}
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
      <AlertDialog.Root open={updateOpen} onOpenChange={setUpdateOpen}>
        <AlertDialog.Content title={`Update the game on ${server.name}?`} description="Downloads the newest game files with SteamCMD. Settings, worlds and other saved files stay. The progress shows on this page.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="primary" onClick={() => run("update", "Updating the game")}>Update game</AlertDialog.Close>
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

/**
 * States in which the panel accepts an upgrade (the server isn't running).
 */
const STOPPED_STATES: readonly ServerState[] = ["stopped", "install_failed", "crashed"];

/**
 * "Update available": a newer version of the game's definition was synced. Applying it re-provisions the server, so it
 * needs the server stopped. When the new version rejects a kept setting (a 400 naming the variable), a form asks for
 * new values of just those settings and sends them with the upgrade.
 */
function UpdateNotice(props: { server: GameServerDetailResponse; onChanged: () => Promise<void> }) {
  const { server, onChanged } = props;
  const latest = server.latestDefinition;
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<FormVariable[]>([]); // Settings the new version refused, in the order met.
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const fields = useVariableOptions(latest?.id ?? 0, rejected);
  if (!latest) return null;

  const stopped = STOPPED_STATES.includes(server.state);
  const canApply = stopped && server.host.online;

  const closeForm = () => {
    setRejected([]);
    setValues({});
    setErrors({});
    setFormError(null);
  };

  const apply = async (variables?: FormVariable[], filled?: FormValues) => {
    setBusy(true);
    setFormError(null);
    try {
      const replacements = variables && filled ? toValues(variables, filled) : undefined;
      const result = await ServerApi.upgrade(server.id, { definitionId: latest.id, variables: replacements });
      closeForm();
      await onChanged();
      if (result.reinstall) notify.ok("Update applied", "The install steps changed, so the server reinstalls the next time it starts.");
      else notify.ok("Update applied", "The server uses the new version the next time it starts.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const field = error instanceof ApiError && error.status === 400 ? await rejectedField(message) : null;
      if (field) {
        const next = rejected.some((variable) => variable.key === field.key) ? rejected : [...rejected, field];
        setRejected(next);
        setValues((current) => ({ ...initialValues([field]), ...current }));
        setErrors({ [field.key]: message });
      }
      else if (rejected.length > 0) setFormError(message);
      else notify.error(error, "Couldn't apply the update");
    } finally {
      setBusy(false);
    }
  };

  // The new version's declaration of the variable a 400 names, or null when it names none.
  const rejectedField = async (message: string): Promise<FormVariable | null> => {
    try {
      const variables = fromDefinition(await DefinitionApi.get(latest.id));
      const key = errorFieldFor(message, variables);
      return variables.find((variable) => variable.key === key) ?? null;
    } catch {
      return null;
    }
  };

  const submitFix = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(fields, values);
    setErrors(found);
    if (Object.keys(found).length === 0) apply(fields, values);
  };

  return (
    <Card>
      <CardHeader
        leading={<IconTile icon={CircleArrowUp} tone="info" />}
        title="Update available"
        description={<>A newer version of {server.definition.name} was synced {formatAgo(latest.syncedAt)}: <span className="io-mono">{formatCommit(server.definition.commit)} → {formatCommit(latest.commit)}</span></>}
      />
      <CardBody>
        <Stack gap="8">
          <span>
            Applying it sets the server up again with the new version. Your settings and saved files are kept. If the new version changes how the game is installed, the server also reinstalls the next time it starts.
          </span>
          {!canApply && (
            <span className="io-text-muted" role="note">
              {stopped ? "The host is offline, so the update can't be applied right now." : "Stop the server to apply the update."}
            </span>
          )}
        </Stack>
      </CardBody>
      <CardFooter>
        <Button variant="primary" icon={CircleArrowUp} disabled={!canApply} loading={busy} onClick={() => setOpen(true)}>Apply update</Button>
      </CardFooter>
      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Content title={`Update ${server.name}?`} description={`The server moves from ${formatCommit(server.definition.commit)} to ${formatCommit(latest.commit)} of ${server.definition.name}.`}>
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="primary" onClick={() => apply()}>Apply update</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <Dialog.Root open={rejected.length > 0} onOpenChange={(next) => !next && closeForm()}>
        <Dialog.Content title="Some settings need new values" description={`The new version of ${server.definition.name} doesn't accept these settings as they are. Pick new values to finish the update.`}>
          <form onSubmit={submitFix}>
            <Dialog.Body>
              <Stack gap="16">
                <VariableForm variables={fields} values={values} errors={errors} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} disabled={busy} />
                <FormError>{formError}</FormError>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.Close>Cancel</Dialog.Close>
              <Button type="submit" variant="primary" loading={busy}>Apply update</Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </Card>
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
            <Fact label="Source">
              <Stack direction="row" gap="8" align="center" wrap>
                <span>{server.source.kind === "local" ? "Built in" : server.source.name}</span>
                {server.source.kind === "git" && <span className="io-mono io-text-muted">{formatCommit(server.definition.commit)}</span>}
              </Stack>
            </Fact>
            <Fact label="Memory"><span className="io-mono">{formatBytes(server.limits.memoryMb * 1024 * 1024)}</span></Fact>
            <Fact label="Owner">{server.owner.username}</Fact>
          </Grid>
        </Stack>
      </CardBody>
    </Card>
  );
}
