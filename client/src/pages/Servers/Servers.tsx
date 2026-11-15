import { Button, Card, CardBody, CardHeader, EmptyState, Stack } from "@ionnet/iontronic/react";
import { Gamepad2, Plus } from "@ionnet/iontronic/icons";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/` and `/servers`: `ServerApi.useServers()` list (name, game, host, state Badge with install progress, address
 * with copy, owner for SERVERS_MANAGE_ALL). `server.state` events update rows in place. SERVERS_CREATE: "New server".
 */
export default function Servers(props: Props) {
  const auth = useAuth();
  // TODO(builder): D
  return (
    <Stack gap="16">
      <Card>
        <CardHeader
          title="Servers"
          actions={auth.has("SERVERS_CREATE") ? <Button variant="primary" icon={Plus} onClick={() => navigate("/servers/new")}>New server</Button> : undefined}
        />
        <CardBody>
          <EmptyState icon={Gamepad2} title="No servers yet" description="Create one on a host you have access to." />
        </CardBody>
      </Card>
    </Stack>
  );
}
