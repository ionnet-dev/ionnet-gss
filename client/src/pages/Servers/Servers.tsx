import { Badge, Button, Card, CardBody, EmptyState, List, ListItem, Spinner, Stack } from "@ionnet/iontronic/react";
import { Gamepad2, Plus } from "@ionnet/iontronic/icons";
import type { GameServerDto } from "@shared/api/servers.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import ServerStateBadge, { describeProgress } from "@/components/ServerState/ServerState.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/` and `/servers`: every server you can see with its live state. `server.state` events update the rows in place;
 * `server.updated` refetches the list.
 */
export default function Servers(_props: Props) {
  const auth = useAuth();
  const canCreate = auth.has("SERVERS_CREATE");
  const showOwner = auth.has("SERVERS_MANAGE_ALL");
  const servers = ServerApi.useServers();
  const patches = ServerApi.useStatePatches();

  const create = canCreate
    ? <Button variant="primary" icon={Plus} onClick={() => navigate("/servers/new")}>New server</Button>
    : undefined;

  return (
    <Stack gap="16">
      <PageHeader title="Servers" description="Your game servers and what they're doing right now." actions={servers.data?.length ? create : undefined} />
      <Card>
        <CardBody>
          {servers.data === null && servers.loading && <Stack align="center"><Spinner label="Loading servers" /></Stack>}
          {servers.data === null && servers.error && <LoadError title="Couldn't load the servers" error={servers.error} onRetry={servers.reload} />}
          {servers.data?.length === 0 && <ServersEmpty canCreate={canCreate} />}
          {servers.data && servers.data.length > 0 && (
            <List>
              {servers.data.map((server) => (
                <ServerItem key={server.id} server={ServerApi.applyState(server, patches[server.id])} showOwner={showOwner} />
              ))}
            </List>
          )}
        </CardBody>
      </Card>
    </Stack>
  );
}

function ServersEmpty(props: { canCreate: boolean }) {
  const { canCreate } = props;
  return (
    <EmptyState
      icon={Gamepad2}
      title="No servers yet"
      description={canCreate
        ? "Pick a host, pick a game, and your server is installed and ready to start in a few minutes."
        : "You can't create servers yet. Ask an admin to give you access."}
      actions={canCreate ? <Button variant="primary" icon={Plus} onClick={() => navigate("/servers/new")}>Create a server</Button> : undefined}
    />
  );
}

function ServerItem(props: { server: GameServerDto; showOwner: boolean }) {
  const { server, showOwner } = props;
  const tone = server.state === "running" ? "ok" : server.state === "crashed" || server.state === "install_failed" ? "bad" : server.state === "stopped" ? "neutral" : "info";
  const details = [server.definition.name, server.host.name + (server.host.online ? "" : " (offline)")];
  if (showOwner && server.access === "owner") details.push(`by ${server.owner.username}`);
  const progress = server.state === "installing" ? describeProgress(server.installProgress) : null;
  return (
    <ListItem
      render={<Link to={`/servers/${server.id}`} />}
      icon={Gamepad2}
      tone={tone}
      title={server.name}
      badges={
        <>
          <ServerStateBadge state={server.state} progress={server.installProgress} />
          {server.access !== "owner" && <Badge tone="info" size="sm">Shared by {server.owner.username}</Badge>}
        </>
      }
      description={progress ? `Installing · step ${progress}` : details.join(" · ")}
      meta={progress ? details.join(" · ") : undefined}
      trailing={server.address ? <span className="io-mono">{server.address}</span> : undefined}
    />
  );
}
