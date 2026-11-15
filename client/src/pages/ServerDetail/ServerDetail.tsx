import { Card, CardBody, CardHeader, Stack } from "@ionnet/iontronic/react";
import Console from "@/components/Console/Console.tsx";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/servers/<uuid>`: `ServerApi.useServer(id)`. Header: name, game, host (offline warning), state Badge (+ install
 * step "2/3 download", reason for install_failed/crashed), address with copy, Start / Stop (Menu: Kill) / Restart /
 * Reinstall (AlertDialog) / Delete (AlertDialog, "keep data" Checkbox). Tabs: Console (`<Console>`), Settings
 * (variables form prefilled from `variables`, disabled unless stopped, `reinstallPending` warning on save, autostart
 * and auto-restart Switches). `server.state` updates the header in place.
 */
export default function ServerDetail(props: Props) {
  const { match } = props;
  const serverId = match.params[0];
  // TODO(builder): D
  return (
    <Stack gap="16">
      <Card>
        <CardHeader title="Server" description={<span className="io-mono">{serverId}</span>} />
        <CardBody>
          <Console serverId={serverId} canSend={false} />
        </CardBody>
      </Card>
    </Stack>
  );
}
