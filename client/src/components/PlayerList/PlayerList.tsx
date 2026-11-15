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
  // TODO(builder)
  return <span>{players.length}</span>;
}
