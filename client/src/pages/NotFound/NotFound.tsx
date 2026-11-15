import { Button, Card, CardBody, EmptyState } from "@ionnet/iontronic/react";
import { MapPinOff } from "@ionnet/iontronic/icons";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

export default function NotFound(props: Props) {
  const { match } = props;
  return (
    <Card>
      <CardBody>
        <EmptyState
          icon={MapPinOff}
          title="Page not found"
          description={<span className="io-mono">{match.path}</span>}
          actions={<Button onClick={() => navigate("/")}>Go home</Button>}
        />
      </CardBody>
    </Card>
  );
}
