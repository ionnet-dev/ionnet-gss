import { Card, CardBody, CardHeader, EmptyState, Stack } from "@ionnet/iontronic/react";
import { Gamepad2 } from "@ionnet/iontronic/icons";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/servers/new` (SERVERS_CREATE): three steps. Host (`HostApi.useHosts()`, online ones selectable) → game
 * (`DefinitionApi.useDefinitions()`) → name + the variables form generated from `DefinitionDto.variables`
 * (`VariableForm` component: string → Input, number → Input type=number with unit, boolean → Switch, select →
 * Select, secret with generate → hidden "generated", secret without → password Input; defaults prefilled, labels
 * fall back to the key). Submit → `ServerApi.create` → `/servers/<id>`. Panel 400/409 messages shown inline.
 */
export default function ServerCreate(props: Props) {
  // TODO(builder): D
  return (
    <Stack gap="16">
      <Card>
        <CardHeader title="New server" />
        <CardBody>
          <EmptyState icon={Gamepad2} title="Pick a host" />
        </CardBody>
      </Card>
    </Stack>
  );
}
