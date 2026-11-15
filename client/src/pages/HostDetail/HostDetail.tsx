import { type FormEvent, type ReactNode, useState } from "react";
import { AlertDialog, Badge, Button, Card, CardBody, CardFooter, CardHeader, Grid, Input, Meter, Spinner, Stack } from "@ionnet/iontronic/react";
import { ArrowLeft, Power, Trash2 } from "@ionnet/iontronic/icons";
import { LIMITS } from "@shared/constants.ts";
import type { HostDetailResponse, UpdateHostBody } from "@shared/api/hosts.ts";
import type { EgressFacts } from "@shared/protocol/protocol.gen.ts";
import { HostApi } from "@/Api/HostApi.ts";
import { formatAgo, formatBytes, formatDateTime, formatUptime } from "@/components/Format/format.ts";
import HostStatus from "@/components/HostStatus/HostStatus.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/hosts/<uuid>`: facts of one host with live status. Admins can rename it, change its address, port pool and
 * capacity, disable it, or remove it.
 */
export default function HostDetail(props: Props) {
  const { match } = props;
  const hostId = match.params[0];
  const auth = useAuth();
  const canManage = auth.has("HOSTS_MANAGE");
  const resource = HostApi.useHost(hostId);
  const host = resource.data;

  const back = <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate("/hosts")}>Hosts</Button>;

  if (!host) {
    return (
      <Stack gap="16">
        <PageHeader title="Host" leading={back} />
        <Card>
          <CardBody>
            {resource.error
              ? <LoadError title="Couldn't load this host" error={resource.error} onRetry={resource.reload} />
              : <Stack align="center"><Spinner label="Loading host" /></Stack>}
          </CardBody>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap="16">
      <PageHeader
        title={host.name}
        leading={back}
        description={<Stack direction="row" gap="8" align="center" wrap><HostStatus host={host} /><span>{host.online ? "Connected now" : `Last seen ${formatAgo(host.lastSeenAt)}`}</span></Stack>}
        actions={canManage ? <HostActions host={host} onChanged={resource.reload} /> : undefined}
      />
      <Overview host={host} />
      {host.facts ? <System host={host} /> : <WaitingForFacts />}
      {canManage && <Settings host={host} onChanged={resource.reload} />}
    </Stack>
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
 * Egress filtering on the host: whether servers without private network access can start there.
 */
function EgressBadge(props: { egress: EgressFacts | null }) {
  const { egress } = props;
  if (!egress) return <Badge tone="neutral" size="sm">Unknown</Badge>;
  if (egress.filtering) return <Badge tone="ok" size="sm">Working · {egress.restricted} filtered</Badge>;
  return <Badge tone="warn" size="sm">Not working</Badge>;
}

/**
 * The warning under the facts when egress filtering doesn't work (or the agent is too old to report it).
 */
function EgressWarning(props: { egress: EgressFacts | null }) {
  const { egress } = props;
  if (egress?.filtering) return null;
  const text = egress
    ? `Egress filtering doesn't work on this host, so servers that may not reach private networks won't start here. ${egress.error ?? ""}`
    : "This agent doesn't report egress filtering (it may be older than this panel). Servers on it may be able to reach private networks.";
  return <span role="status" style={{ color: "var(--io-color-hue-text-warn)" }}>{text}</span>;
}

function Overview(props: { host: HostDetailResponse }) {
  const { host } = props;
  return (
    <Card>
      <CardHeader title="Overview" />
      <CardBody>
        <Grid minChildWidth="12rem" gap="16">
          <Fact label="Address">{host.address ?? host.facts?.hostname ?? "Not set"}</Fact>
          <Fact label="Servers">{host.serverCount}</Fact>
          <Fact label="Port pool"><span className="io-mono">{host.portPool || "None"}</span></Fact>
          <Fact label="Agent">{host.agentVersion ? <span className="io-mono">{host.agentVersion}</span> : "Not connected yet"}</Fact>
          <Fact label="Enrolled">{formatDateTime(host.enrolledAt)}</Fact>
        </Grid>
      </CardBody>
    </Card>
  );
}

function WaitingForFacts() {
  return (
    <Card>
      <CardHeader title="System" description="Details appear when the agent first connects." />
    </Card>
  );
}

function System(props: { host: HostDetailResponse }) {
  const facts = props.host.facts!;
  const memoryUsed = facts.memory.totalBytes - facts.memory.availableBytes;
  const diskUsed = facts.disk.totalBytes - facts.disk.freeBytes;
  return (
    <Card>
      <CardHeader title="System" description={facts.hostname} />
      <CardBody>
        <Stack gap="24">
          <Grid minChildWidth="14rem" gap="16">
            <Fact label="Operating system">{facts.os.name}</Fact>
            <Fact label="Kernel"><span className="io-mono">{facts.os.kernel} · {facts.os.arch}</span></Fact>
            <Fact label="CPU">{facts.cpu.model} · {facts.cpu.threads} threads</Fact>
            <Fact label="Load (1 min)"><span className="io-mono">{facts.cpu.load1.toFixed(2)}</span></Fact>
            <Fact label="Docker">{facts.docker ? <span className="io-mono">{facts.docker.version}</span> : "Docker not reachable"}</Fact>
            <Fact label="Uptime">{formatUptime(facts.uptimeSec)}</Fact>
            <Fact label="Egress filtering"><EgressBadge egress={facts.egress ?? null} /></Fact>
          </Grid>
          <EgressWarning egress={facts.egress ?? null} />
          <Grid minChildWidth="16rem" gap="24">
            <Meter
              label="Memory"
              showValue
              value={memoryUsed}
              max={facts.memory.totalBytes}
              tone={memoryUsed / facts.memory.totalBytes > 0.85 ? "warn" : "accent"}
              format={(value) => `${formatBytes(value)} of ${formatBytes(facts.memory.totalBytes)}`}
            />
            <Meter
              label={`Disk (${facts.disk.path})`}
              showValue
              value={diskUsed}
              max={facts.disk.totalBytes}
              tone={diskUsed / facts.disk.totalBytes > 0.85 ? "warn" : "accent"}
              format={(value) => `${formatBytes(value)} of ${formatBytes(facts.disk.totalBytes)}`}
            />
          </Grid>
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * Disable / enable and remove, with confirmation for the destructive ones.
 */
function HostActions(props: { host: HostDetailResponse; onChanged: () => Promise<void> }) {
  const { host, onChanged } = props;
  const notify = useNotify();

  const setDisabled = async (disabled: boolean) => {
    try {
      await HostApi.update(host.id, { disabled });
      await onChanged();
      notify.ok(disabled ? "Host disabled" : "Host enabled");
    } catch (error) {
      notify.error(error, disabled ? "Couldn't disable the host" : "Couldn't enable the host");
    }
  };

  const remove = async () => {
    try {
      await HostApi.remove(host.id);
      notify.ok("Host removed");
      navigate("/hosts");
    } catch (error) {
      notify.error(error, "Couldn't remove the host");
    }
  };

  return (
    <>
      {host.disabled
        ? <Button icon={Power} onClick={() => setDisabled(false)}>Enable</Button>
        : (
          <AlertDialog.Root>
            <AlertDialog.Trigger icon={Power}>Disable</AlertDialog.Trigger>
            <AlertDialog.Content title={`Disable ${host.name}?`} description="Its agent is disconnected and no new servers can be placed on it. You can enable it again later.">
              <AlertDialog.Footer>
                <AlertDialog.Close>Cancel</AlertDialog.Close>
                <AlertDialog.Close variant="danger" onClick={() => setDisabled(true)}>Disable</AlertDialog.Close>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        )}
      <AlertDialog.Root>
        <AlertDialog.Trigger variant="danger" icon={Trash2}>Remove</AlertDialog.Trigger>
        <AlertDialog.Content title={`Remove ${host.name}?`} description="The host is forgotten and its agent can no longer connect. A host that still has servers can't be removed.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={remove}>Remove</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function parseLimit(value: string): number | null | undefined {
  const text = value.trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * Name, address, port pool and capacity. The panel validates the pool; its message shows under the field.
 */
function Settings(props: { host: HostDetailResponse; onChanged: () => Promise<void> }) {
  const { host, onChanged } = props;
  const notify = useNotify();
  const [name, setName] = useState(host.name);
  const [address, setAddress] = useState(host.address ?? "");
  const [portPool, setPortPool] = useState(host.portPool);
  const [memory, setMemory] = useState(host.capacity.maxMemoryMb?.toString() ?? "");
  const [cpu, setCpu] = useState(host.capacity.maxCpuMillis?.toString() ?? "");
  const [disk, setDisk] = useState(host.capacity.maxDiskMb?.toString() ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "Give the host a name.";
    const limits = { maxMemoryMb: parseLimit(memory), maxCpuMillis: parseLimit(cpu), maxDiskMb: parseLimit(disk) };
    if (limits.maxMemoryMb === undefined) found.memory = "Use a whole number, or leave empty for the host's total.";
    if (limits.maxCpuMillis === undefined) found.cpu = "Use a whole number, or leave empty for the host's total.";
    if (limits.maxDiskMb === undefined) found.disk = "Use a whole number, or leave empty for the host's total.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const body: UpdateHostBody = {
      name: name.trim(),
      address: address.trim() || null,
      portPool: portPool.trim(),
      capacity: { maxMemoryMb: limits.maxMemoryMb, maxCpuMillis: limits.maxCpuMillis, maxDiskMb: limits.maxDiskMb },
    };
    setBusy(true);
    try {
      await HostApi.update(host.id, body);
      await onChanged();
      notify.ok("Host saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/port/i.test(message)) setErrors({ portPool: message });
      else notify.error(error, "Couldn't save the host");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Settings" />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="16">
            <Input label="Name" required value={name} maxLength={LIMITS.HOST_NAME_MAX} onChange={(event) => setName(event.target.value)} error={errors.name} />
            <Input
              label="Address"
              description="What players connect to. Empty uses the host's own hostname."
              mono
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <Input
              label="Port pool"
              description="Ports servers on this host may use, as ranges, e.g. 25565-25664,27015-27064."
              mono
              value={portPool}
              onChange={(event) => setPortPool(event.target.value)}
              error={errors.portPool}
            />
            <Grid minChildWidth="12rem" gap="16">
              <Input label="Memory limit (MB)" inputMode="numeric" placeholder="All" value={memory} onChange={(event) => setMemory(event.target.value)} error={errors.memory} />
              <Input label="CPU limit (millicores)" inputMode="numeric" placeholder="All" value={cpu} onChange={(event) => setCpu(event.target.value)} error={errors.cpu} />
              <Input label="Disk limit (MB)" inputMode="numeric" placeholder="All" value={disk} onChange={(event) => setDisk(event.target.value)} error={errors.disk} />
            </Grid>
          </Stack>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy}>Save changes</Button>
        </CardFooter>
      </form>
    </Card>
  );
}
