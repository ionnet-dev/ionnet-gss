import { EmptyState } from "@ionnet/iontronic/react";
import { SquareTerminal } from "@ionnet/iontronic/icons";

export interface ConsoleProps {
  serverId: string;
  /**
   * Show the input line (running or starting).
   */
  canSend: boolean;
}

/**
 * Live console for one server: `liveSocket.subscribeTopic("server:<id>")`, on `subscribed` fetch
 * `ServerApi.backlog(id)`, merge live `server.console` lines by `seq` (drop ≤ last seen), keep the last 2000, ANSI
 * colours rendered as spans (no HTML injection), autoscroll unless the user scrolled up, input with history (↑/↓)
 * → `ServerApi.sendInput`. Mono font and colours from `--io-*` only.
 */
export default function Console(props: ConsoleProps) {
  const { serverId, canSend } = props;
  // TODO(builder): D
  return <EmptyState icon={SquareTerminal} title="Console" description={canSend ? "Connecting…" : "The server is not running."} />;
}
