import { Card, CardBody, CardHeader, Chip } from "@ionnet/iontronic/react";
import { Users } from "@ionnet/iontronic/icons";

export interface PlayerListProps {
  players: string[];
  supported: boolean; // false: the game reports no players; render nothing.
}

/**
 * Players online (M4): count and names (`List`/`Chip`), "Nobody online" when empty. Data comes from the parent's
 * `MetricsApi.useLiveMetrics` so the page subscribes once.
 */
export default function PlayerList(props: PlayerListProps) {
  const { players, supported } = props;
  if (!supported) return null;
  return (
    <Card>
      <CardHeader
        title={`Players online: ${players.length}`}
        description="Read from the game's console while it runs."
      />
      <CardBody>
        {players.length === 0
          ? (
            <p className="io-text-muted" style={{ margin: 0, display: "flex", alignItems: "center", gap: "var(--io-space-8)" }}>
              <Users size={16} aria-hidden="true" /> Nobody online
            </p>
          )
          : (
            <ul aria-label="Players online" style={{ display: "flex", flexWrap: "wrap", gap: "var(--io-space-8)", margin: 0, padding: 0, listStyle: "none" }}>
              {players.map((name) => <li key={name}><Chip>{name}</Chip></li>)}
            </ul>
          )}
      </CardBody>
    </Card>
  );
}
