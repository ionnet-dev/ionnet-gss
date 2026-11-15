import { useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, List, ListItem, Spinner, Stack } from "@ionnet/iontronic/react";
import { Plus, Server } from "@ionnet/iontronic/icons";
import type { HostDto, EnrolTokenDto } from "@shared/api/hosts.ts";
import type { HostFacts } from "@shared/protocol/protocol.gen.ts";
import { HostApi } from "@/Api/HostApi.ts";
import EnrolDialog from "@/components/EnrolDialog/EnrolDialog.tsx";
import { formatAgo, formatBytes, formatUntil } from "@/components/Format/format.ts";
import HostStatus from "@/components/HostStatus/HostStatus.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

type HostRow = HostDto;

/**
 * `/hosts` (and `/`): every visible host with live online state. Admins can enrol a host and see the open tokens.
 */
export default function Hosts(props: Props) {
  const auth = useAuth();
  const canManage = auth.has("HOSTS_MANAGE");
  const hosts = HostApi.useHosts();
  const [enrolOpen, setEnrolOpen] = useState(false);

  const enrolButton = canManage
    ? <Button variant="primary" icon={Plus} onClick={() => setEnrolOpen(true)}>Enrol a host</Button>
    : undefined;

  return (
    <Stack gap="16">
      <PageHeader title="Hosts" description="The machines your game servers run on." actions={hosts.data?.length ? enrolButton : undefined} />
      <Card>
        <CardBody>
          {hosts.data === null && hosts.loading && <Stack align="center"><Spinner label="Loading hosts" /></Stack>}
          {hosts.data === null && hosts.error && <LoadError title="Couldn't load the hosts" error={hosts.error} onRetry={hosts.reload} />}
          {hosts.data?.length === 0 && <HostsEmpty canManage={canManage} onEnrol={() => setEnrolOpen(true)} />}
          {hosts.data && hosts.data.length > 0 && (
            <List>
              {(hosts.data as HostRow[]).map((host) => <HostItem key={host.id} host={host} />)}
            </List>
          )}
        </CardBody>
      </Card>
      {canManage && <PendingTokens />}
      {canManage && <EnrolDialog open={enrolOpen} onOpenChange={setEnrolOpen} />}
    </Stack>
  );
}

function HostsEmpty(props: { canManage: boolean; onEnrol: () => void }) {
  const { canManage, onEnrol } = props;
  return (
    <EmptyState
      icon={Server}
      title="No hosts yet"
      description={canManage
        ? "A host is a Linux machine with Docker that runs your game servers. Enrol one with a one-time command: install gss-agent on the machine, run the command, and it appears here as soon as it connects."
        : "A host is a machine that runs game servers. An admin needs to enrol one and give you access to it."}
      actions={canManage ? <Button variant="primary" icon={Plus} onClick={onEnrol}>Enrol a host</Button> : undefined}
    />
  );
}

function HostItem(props: { host: HostRow }) {
  const { host } = props;
  const facts = host.facts;
  const details = facts
    ? [
      facts.os.name,
      `${facts.cpu.threads} threads`,
      `${formatBytes(facts.memory.totalBytes)} RAM`,
      `${formatBytes(facts.disk.freeBytes)} free of ${formatBytes(facts.disk.totalBytes)}`,
    ].join(" · ")
    : host.agentVersion ? `Agent ${host.agentVersion}` : "Waiting for the first connection";
  return (
    <ListItem
      render={<Link to={`/hosts/${host.id}`} />}
      icon={Server}
      tone={host.disabled ? "warn" : host.online ? "ok" : "neutral"}
      title={host.name}
      badges={<HostStatus host={host} />}
      description={details}
      meta={host.serverCount === 1 ? "1 server" : `${host.serverCount} servers`}
      trailing={host.online ? "Now" : formatAgo(host.lastSeenAt)}
    />
  );
}

function PendingTokens() {
  const tokens = HostApi.useEnrolTokens();
  const notify = useNotify();
  const open = (tokens.data ?? []).filter((token) => token.usedAt === null && new Date(token.expiresAt).getTime() > Date.now());
  if (open.length === 0) return null;

  const revoke = async (token: EnrolTokenDto) => {
    try {
      await HostApi.revokeEnrolToken(token.id);
      await tokens.reload();
    } catch (error) {
      notify.error(error, "Couldn't revoke the token");
    }
  };

  return (
    <Card>
      <CardHeader title="Waiting to be used" description="Enrol commands that haven't been run yet." />
      <CardBody>
        <List>
          {open.map((token) => (
            <ListItem
              key={token.id}
              dense
              icon={Server}
              tone="info"
              title={token.name ?? "Unnamed host"}
              badges={<Badge size="sm" tone="neutral">{formatUntil(token.expiresAt)}</Badge>}
              description={<span className="io-mono">…{token.tokenHint}</span>}
              trailing={<Button size="sm" variant="ghost" onClick={() => revoke(token)}>Revoke</Button>}
            />
          ))}
        </List>
      </CardBody>
    </Card>
  );
}
